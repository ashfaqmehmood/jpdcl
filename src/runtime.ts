import { JpdclError } from "./errors.js";
import { resolveCredentials, type Credentials } from "./credentials.js";
import { MAIN_API_URL, mutationsEnabled } from "./config.js";
import { JpdclClient } from "./main-client.js";
import { JpdclLedgerClient, ledgerPeriod, type LedgerPeriodOptions } from "./ledger-client.js";
import { loadSession, saveSession } from "./session.js";
import {
  decodeJwt,
  SmartMeterClient,
  smartApiUrlFromAppUrl,
  type SmartReportOptions,
  type SmartReportType,
} from "./smart-client.js";
import { calculateDomesticMeteredCharges, type DomesticTariffInput } from "./tariff.js";
import type { MainSession, PortalResponse } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class JpdclRuntime {
  readonly main: JpdclClient;
  readonly ledger = new JpdclLedgerClient();
  smart?: SmartMeterClient;

  private constructor(
    session: MainSession | undefined,
    private readonly options: {
      credentials?: Credentials;
      persistent: boolean;
      allowMutations: boolean;
      smartFetch?: typeof fetch;
    },
  ) {
    this.main = new JpdclClient(
      session,
      MAIN_API_URL,
      options.allowMutations,
      options.credentials,
      options.persistent ? saveSession : async () => {},
    );
    if (session?.smart?.token) {
      this.smart = new SmartMeterClient(
        session.smart.token,
        session.smart.baseUrl,
        options.allowMutations,
        session.smart.tenantId,
        undefined,
        session.smart.accountScoped ?? false,
        options.smartFetch,
      );
    }
  }

  static async create(options: {
    credentials?: Credentials;
    session?: MainSession;
    persistent?: boolean;
    allowMutations?: boolean;
    smartFetch?: typeof fetch;
  } = {}): Promise<JpdclRuntime> {
    const persistent = options.persistent ?? true;
    const session = options.session ?? (persistent ? await loadSession() : undefined);
    return new JpdclRuntime(session, {
      credentials: options.credentials,
      persistent,
      allowMutations: options.allowMutations ?? mutationsEnabled(),
      smartFetch: options.smartFetch,
    });
  }

  async login(loginId: string, password: string): Promise<PortalResponse> {
    const response = await this.main.login(loginId, password);
    await this.persist();
    return response;
  }

  async persist(): Promise<void> {
    if (!this.options.persistent) return;
    const session = this.main.currentSession;
    if (!session) return;
    if (this.smart?.bearerToken) {
      session.smart = {
        token: this.smart.bearerToken,
        baseUrl: this.smart.baseUrl,
        tenantId: this.smart.effectiveTenantId,
        accountId: this.smart.accountId,
        meterNumber: this.smart.meterNumber,
        userId: typeof this.smart.claims.sub === "string" ? this.smart.claims.sub : undefined,
        expiresAt: this.smart.expiresAt,
        accountScoped: this.smart.accountScoped,
      };
    }
    await saveSession(session);
  }

  async ensureLogin(): Promise<void> {
    if (this.main.currentSession) return;
    const credentials = this.options.credentials ?? await resolveCredentials();
    if (!credentials) {
      throw new JpdclError("Run `jpdcl auth login` or set JPDCL_LOGIN_ID and JPDCL_PASSWORD", 401);
    }
    await this.login(credentials.loginId, credentials.password);
  }

  async ensureSmart(accountId?: string, meterNumber?: string): Promise<SmartMeterClient> {
    const smartMatches = this.smart?.bearerToken
      && this.smart.accountScoped
      && (!accountId || accountId === this.smart.accountId)
      && (!meterNumber || meterNumber === this.smart.meterNumber)
      && (!this.smart.expiresAt || new Date(this.smart.expiresAt).getTime() > Date.now() + 30_000);
    if (smartMatches) return this.smart!;
    await this.ensureLogin();
    const customer = await this.main.customerInfo(accountId);
    const customerData = record(customer.data) ?? {};
    const resolvedAccount = accountId ?? this.main.currentSession?.primaryAccountId;
    const resolvedMeter = meterNumber ?? String(
      customerData.mtrSrNum ?? customerData.meterNumber ?? customerData.meterNo ?? "",
    );
    if (!resolvedAccount || !resolvedMeter) throw new JpdclError("Account ID and meter number are required", 400);
    const sso = await this.main.smartSso(resolvedAccount, resolvedMeter);
    const ssoData = record(sso.data) ?? {};
    const jwt = ssoData.jwt;
    if (typeof jwt !== "string") throw new JpdclError(sso.message ?? "JPDCL did not issue a smart-meter token", 502, sso);
    const appUrl = typeof ssoData.app_url === "string" ? ssoData.app_url : undefined;
    const claims = decodeJwt(jwt);
    const tenantId = typeof claims.currentAccountTenantId === "string" ? claims.currentAccountTenantId : undefined;
    const initialSmart = new SmartMeterClient(
      jwt,
      smartApiUrlFromAppUrl(appUrl),
      this.options.allowMutations,
      tenantId,
      undefined,
      false,
      this.options.smartFetch,
    );
    this.smart = await initialSmart.switchAccount(resolvedAccount, resolvedMeter);
    await this.persist();
    return this.smart;
  }

  async aiSnapshot(accountId?: string): Promise<Record<string, unknown>> {
    await this.ensureLogin();
    const main = await this.main.digest(accountId);
    const resolvedAccount = accountId ?? this.main.currentSession?.primaryAccountId;
    const errors: Array<{ source: string; message: string }> = [];
    const [smartResult, ledgerResult, tariffResult] = await Promise.all([
      capture((async () => {
      const client = await this.ensureSmart(resolvedAccount);
        return (await client.dashboard(resolvedAccount, { includeDerived: false })).data;
      })()),
      capture(this.energyLedger(resolvedAccount, { limit: 7 })),
      capture(this.tariffEstimate(resolvedAccount)),
    ]);
    if (!smartResult.ok) errors.push({ source: "smart-meter", message: smartResult.error });
    if (!ledgerResult.ok) errors.push({ source: "daily-meter-ledger", message: ledgerResult.error });
    if (!tariffResult.ok) errors.push({ source: "tariff-calculation", message: tariffResult.error });
    const smart = smartResult.ok ? smartResult.value : null;
    const ledger = ledgerResult.ok ? ledgerResult.value : null;
    const tariff = tariffResult.ok ? tariffResult.value : null;
    await this.persist();
    return {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      dataPolicy: {
        mode: "observed-plus-deterministic-calculations",
        excludes: ["forecasts", "recommendations", "energy-saving tips", "smartTips"],
        calculated: [
          "daily and period usage from cumulative register subtraction",
          "provisional billable kWh from the net-import register for net-meter accounts",
          "tariff estimate from observed kWh and official published rates",
        ],
      },
      identity: {
        accountId: resolvedAccount ?? null,
        meterNumber: this.smart?.meterNumber ?? record(main.meter)?.number ?? null,
        plan: this.smart ? (String(this.smart.claims.currentAccountIsMeterPrepaid).toLowerCase() === "true" ? "prepaid" : "postpaid") : null,
      },
      sources: {
        mainPortal: { available: true, kind: "account-and-billing-records" },
        smartMeter: { available: smart !== null, kind: "meter-and-consumer-api-records" },
        dailyMeterLedger: { available: ledger !== null, kind: "daily-import-export-registers" },
      },
      data: { main, smart, ledger, tariff },
      errors,
    };
  }

  async tariffEstimate(
    accountId?: string,
    overrides: Partial<DomesticTariffInput> = {},
    options: { allowSmartFallback?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    await this.ensureLogin();
    const customerResponse = await this.main.customerInfo(accountId);
    const customer = record(customerResponse.data) ?? {};
    const resolvedAccount = accountId ?? this.main.currentSession?.primaryAccountId;
    const category = String(customer.consumerType ?? customer.saTypeCd ?? customer.category ?? "").toUpperCase();
    if (!category.includes("DOM") && category !== "1") {
      throw new JpdclError(`Automatic tariff calculation currently supports domestic metered accounts; portal category is ${category || "unknown"}`, 422);
    }
    const sanctionedLoadKw = overrides.sanctionedLoadKw ?? Number(customer.sanctionedLoad);
    if (!Number.isFinite(sanctionedLoadKw)) throw new JpdclError("The portal did not provide a valid sanctioned load", 422);

    let unitsKwh = overrides.unitsKwh;
    let usageSource: Record<string, unknown> = { kind: "manual" };
    if (unitsKwh === undefined) {
      const consumerId = String(customer.consumerID ?? "");
      try {
        const daily = await this.ledger.consumer(consumerId);
        const period = ledgerPeriod(daily, { limit: 0 });
        const periodRecord = record(period.period) ?? {};
        unitsKwh = Number(periodRecord.provisionalBillableKwh);
        usageSource = {
          kind: "daily-register-ledger",
          endpoint: "ledger_consumer_readings",
          netMeter: daily.consumer.netMeter,
          basis: periodRecord.provisionalBillableBasis,
          from: periodRecord.from,
          to: periodRecord.to,
          latestObservation: periodRecord.latestObservation,
          warning: periodRecord.warning,
        };
      } catch (ledgerError) {
        if (options.allowSmartFallback === false) throw ledgerError;
        const client = await this.ensureSmart(resolvedAccount);
        if (!client.meterNumber) throw new JpdclError("The smart-meter number is unavailable", 422);
        const usage = await client.request("smart_today_monthly", { params: { meterNumber: client.meterNumber } });
        const usageData = record(usage.data) ?? {};
        unitsKwh = Number(usageData.monthlyConsumption);
        usageSource = {
          kind: "smart-meter-current-month-fallback",
          endpoint: "smart_today_monthly",
          latestDate: usageData.latestDate ?? null,
          unit: usageData.unit ?? "kWh",
          ledgerError: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
        };
      }
    }
    if (!Number.isFinite(unitsKwh)) throw new JpdclError("The portal did not provide valid current-month consumption; pass unitsKwh explicitly", 422);
    const prepaid = overrides.prepaid ?? String(customer.postOrPre ?? "").toUpperCase().includes("PREPAID");
    const calculation = calculateDomesticMeteredCharges({
      ...overrides,
      unitsKwh,
      sanctionedLoadKw,
      prepaid,
    });
    return {
      generatedAt: new Date().toISOString(),
      account: {
        accountId: resolvedAccount ?? null,
        portalCategory: customer.consumerType ?? customer.saTypeCd ?? customer.category ?? null,
        mappedTariff: "Domestic Supply - Metered Consumer",
        plan: prepaid ? "prepaid" : "postpaid",
        consumerId: customer.consumerID ?? null,
      },
      usageSource,
      ...calculation,
    };
  }

  async energyLedger(accountId?: string, options: LedgerPeriodOptions = {}): Promise<Record<string, unknown>> {
    await this.ensureLogin();
    const customer = record((await this.main.customerInfo(accountId)).data) ?? {};
    const consumerId = String(customer.consumerID ?? "");
    if (!consumerId) throw new JpdclError("The main portal did not provide a consumer ID", 422);
    const data = await this.ledger.consumer(consumerId);
    return ledgerPeriod(data, options);
  }

  async smartConsumption(
    accountId?: string,
    type: "daily" | "weekly" | "monthly" = "monthly",
    value = 12,
  ): Promise<Record<string, unknown>> {
    if (!Number.isInteger(value) || value < 1 || value > 366) {
      throw new JpdclError("Consumption value must be an integer from 1 to 366", 400);
    }
    const client = await this.ensureSmart(accountId);
    if (!client.meterNumber) throw new JpdclError("The smart-meter number is unavailable", 422);
    const [current, comparison] = await Promise.all([
      client.request("smart_today_monthly", { params: { meterNumber: client.meterNumber } }),
      client.consumption(accountId, type, value),
    ]);
    return {
      _meta: {
        dataClass: "utility-reported-consumption",
        generatedAt: new Date().toISOString(),
        currentSource: "smart_today_monthly",
        comparisonSource: "smart_consumption_comparison",
        warning: "Portal timestamps determine freshness; these values are not derived from instantaneous current or cumulative registers.",
      },
      current: current.data ?? null,
      comparison: comparison.data ?? null,
      request: { type, value },
    };
  }

  async smartReport(
    accountId: string | undefined,
    reportType: SmartReportType,
    options: SmartReportOptions = {},
  ): Promise<Record<string, unknown>> {
    const client = await this.ensureSmart(accountId);
    const response = await client.report(reportType, accountId, options);
    return {
      _meta: {
        dataClass: "utility-reported-analytical-report",
        generatedAt: new Date().toISOString(),
        source: "smart_report",
        reportType,
        requestedRange: options.from && options.to ? { from: options.from, to: options.to } : null,
        responseMapping: "untruncated-upstream-response",
      },
      report: response.data ?? null,
    };
  }

  async meterHealth(accountId?: string): Promise<Record<string, unknown>> {
    await this.ensureLogin();
    const customer = record((await this.main.customerInfo(accountId)).data) ?? {};
    const resolvedAccount = accountId ?? this.main.currentSession?.primaryAccountId;
    if (!resolvedAccount) throw new JpdclError("An account ID is required", 400);
    const consumerId = String(customer.consumerID ?? "");
    const client = await this.ensureSmart(resolvedAccount);
    if (!client.meterNumber) throw new JpdclError("The smart-meter number is unavailable", 422);
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const [connection, onDemand, onDemandLogs, voltage, powerEvents, ledger, alarms] = await Promise.all([
      capture(this.main.request("main_meter_status", { body: { account_id: resolvedAccount } })),
      capture(client.request("smart_meter_reading", { params: { meterNumber: client.meterNumber } })),
      capture(client.request("smart_on_demand_logs", { params: { meterNumber: client.meterNumber } })),
      capture(client.report("ConsumerVoltageDataProfile", resolvedAccount, { from, to: today, start: 1, end: 100 })),
      capture(client.report("PowerOnOff", resolvedAccount, { from, to: today, start: 1, end: 100 })),
      capture(consumerId ? this.ledger.consumer(consumerId) : Promise.reject(new Error("Consumer ID unavailable"))),
      capture(this.ledger.alarms(client.meterNumber)),
    ]);
    const connectionData = recordResponseData(connection);
    const demandData = recordResponseData(onDemand);
    const demandReadings = Array.isArray(demandData?.data) ? demandData.data : [];
    const demandStatus = Number(demandData?.status);
    const logsData = responseData(onDemandLogs);
    const latestLog = Array.isArray(logsData) ? logsData[0] : null;
    const voltageEnvelope = record(responseData(voltage));
    const voltageRows = Array.isArray(voltageEnvelope?.data) ? voltageEnvelope.data : [];
    const powerEnvelope = record(responseData(powerEvents));
    const powerRows = Array.isArray(powerEnvelope?.data) ? powerEnvelope.data : [];
    const ledgerData = ledger.ok ? ledger.value : undefined;
    return {
      _meta: {
        dataClass: "observed-status-with-explicit-inferences",
        generatedAt: new Date().toISOString(),
        networkConnectivity: "not directly exposed by any consumer endpoint",
      },
      identity: { accountId: resolvedAccount, consumerId, meterNumber: client.meterNumber },
      supply: {
        state: connectionData?.meterConnectionStatus ?? null,
        asOf: connectionData?.currentDate ?? null,
        source: "main_meter_status",
      },
      communication: {
        explicitOnlineStatus: null,
        onDemandRequestAllowed: typeof demandData?.isRequestAllowed === "boolean" ? demandData.isRequestAllowed : null,
        onDemandStatus: Number.isFinite(demandStatus) ? ({ 1: "pending", 2: "failed", 3: "completed" } as Record<number, string>)[demandStatus] ?? "unknown" : null,
        latestRequest: latestLog,
      },
      instantaneousReadings: {
        source: "smart_meter_reading/on-demand",
        readings: demandReadings,
        warning: "These are the latest on-demand values returned by the utility, not a continuous stream.",
      },
      voltageProfile: {
        source: "ConsumerVoltageDataProfile",
        latest: voltageRows[0] ?? null,
        recordCount: voltageRows.length,
      },
      powerEvents: {
        source: "PowerOnOff",
        latest: powerRows[0] ?? null,
        openEvent: powerRows.some((event) => event && typeof event === "object" && !(event as Record<string, unknown>).powerOffEnd),
        recordCount: powerRows.length,
      },
      dailyLedger: ledgerData && typeof ledgerData === "object" && "readings" in ledgerData ? {
        latest: (ledgerData as { readings: unknown[] }).readings[0] ?? null,
        totalRecords: (ledgerData as { readings: unknown[] }).readings.length,
      } : null,
      alarms: alarms.ok ? alarms.value : { unavailable: true, error: alarms.error },
      sourceErrors: [connection, onDemand, onDemandLogs, voltage, powerEvents, ledger, alarms]
        .filter((result) => !result.ok)
        .map((result) => result.error),
    };
  }
}

async function capture<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try { return { ok: true, value: await promise }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

function responseData(result: { ok: true; value: unknown } | { ok: false; error: string }): unknown {
  if (!result.ok) return undefined;
  const value = record(result.value);
  return value && "data" in value ? value.data : result.value;
}

function recordResponseData(result: { ok: true; value: unknown } | { ok: false; error: string }): Record<string, unknown> | undefined {
  return record(responseData(result));
}
