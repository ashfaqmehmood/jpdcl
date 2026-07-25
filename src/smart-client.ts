import { endpointCatalog, isEndpointName, type EndpointName } from "./catalog.js";
import { SMART_API_URL, mutationsEnabled } from "./config.js";
import { assertDateRange } from "./dates.js";
import { AuthenticationError, JpdclError, MutationDisabledError } from "./errors.js";
import { buildUrl, CookieHttpClient } from "./http.js";
import type { PortalResponse, RequestOptions } from "./types.js";

export interface SmartTokenClaims {
  sub?: string;
  exp?: number;
  tenantId?: string;
  currentAccountTenantId?: string;
  currentAccountKno?: string;
  currentAccountMeterNo?: string;
  currentAccountIsMeterPrepaid?: boolean | string;
  currentAccountMeteringMode?: string;
  currentAccountName?: string;
  userAccounts?: string | unknown[];
  [key: string]: unknown;
}

export interface SmartAccount {
  userId?: string;
  uniqueId?: string;
  tenantId?: string;
  mobileNo?: string;
  email?: string | null;
  consumerName?: string;
  kno?: string;
  meterNo?: string;
  isMeterPrepaid?: boolean;
  meteringMode?: string;
  isRegistered?: boolean;
  isPrimaryUser?: boolean;
  userTableId?: number;
  consumerId?: number;
  accountLabel?: string;
  accountType?: string;
}

export class SmartMeterClient {
  claims: SmartTokenClaims;
  private accountSwitch?: Promise<SmartMeterClient>;
  private portalPrime?: Promise<void>;

  constructor(
    private token?: string,
    readonly baseUrl = SMART_API_URL,
    private readonly allowMutations = mutationsEnabled(),
    readonly tenantId?: string,
    private readonly adminToken = process.env.JPDCL_SMART_ADMIN_TOKEN,
    public accountScoped = false,
    private readonly smartFetch: typeof fetch = new CookieHttpClient().fetch,
  ) {
    this.claims = token ? decodeJwt(token) : {};
  }

  get bearerToken(): string | undefined { return this.token; }
  get accounts(): SmartAccount[] { return parseAccounts(this.claims.userAccounts ?? this.claims.UserAccounts ?? this.claims.accounts ?? this.claims.user_accounts); }
  get currentAccount(): SmartAccount | undefined {
    const currentUserId = claimString(this.claims, "currentAccountUserId", "CurrentAccountUserId", "currentQccountUserId", "sub", "userId", "UserId");
    const account = this.accounts.find((item) => currentUserId && (item.userId === currentUserId || item.uniqueId === currentUserId))
      ?? this.accounts.find((item) => item.isPrimaryUser)
      ?? this.accounts[0]
      ?? accountFromClaims(this.claims);
    return account;
  }
  get accountId(): string | undefined {
    return claimString(this.claims, "currentAccountKno", "CurrentAccountKno", "kno", "Kno") ?? this.currentAccount?.kno;
  }
  get meterNumber(): string | undefined {
    return claimString(this.claims, "currentAccountMeterNo", "CurrentAccountMeterNo", "meterNo", "MeterNo") ?? this.currentAccount?.meterNo;
  }
  get currentUserId(): string | undefined {
    return claimString(this.claims, "currentAccountUserId", "CurrentAccountUserId", "currentQccountUserId", "sub", "userId", "UserId")
      ?? this.currentAccount?.userId;
  }
  get effectiveTenantId(): string | undefined {
    return this.tenantId
      ?? claimString(this.claims, "currentAccountTenantId", "CurrentAccountTenantId", "tenantId", "TenantId")
      ?? this.currentAccount?.tenantId;
  }
  get expiresAt(): string | undefined {
    return typeof this.claims.exp === "number" ? new Date(this.claims.exp * 1000).toISOString() : undefined;
  }

  sessionInfo(): Record<string, unknown> {
    return {
      authenticated: Boolean(this.token),
      expiresAt: this.expiresAt,
      accountId: this.accountId,
      meterNumber: this.meterNumber,
      tenantId: this.effectiveTenantId,
      userId: this.currentUserId,
      isPrepaid: booleanClaim(this.claims.currentAccountIsMeterPrepaid),
      meteringMode: stringClaim(this.claims.currentAccountMeteringMode),
      accounts: this.accounts,
    };
  }

  async request<T = unknown>(name: EndpointName | string, options: RequestOptions = {}): Promise<PortalResponse<T>> {
    try {
      return await this.requestOnce<T>(name, options);
    } catch (error) {
      const endpoint = isEndpointName(name) ? endpointCatalog[name] : undefined;
      const retryWithAccountSwitch = error instanceof JpdclError
        && error.status === 403
        && endpoint?.portal === "smart"
        && endpoint.auth === "smart-bearer"
        && name !== "smart_switch_account"
        && Boolean(this.token);
      if (!retryWithAccountSwitch) throw error;
      try {
        await this.refreshAccountContext();
      } catch (switchError) {
        const status = switchError instanceof JpdclError ? switchError.status : 502;
        throw new JpdclError(`Smart-meter account switch failed after HTTP 403: ${switchError instanceof Error ? switchError.message : String(switchError)}`, status, switchError);
      }
      try {
        return await this.requestOnce<T>(name, options);
      } catch (retryError) {
        const status = retryError instanceof JpdclError ? retryError.status : 502;
        throw new JpdclError(`Smart-meter request failed after account switch: ${retryError instanceof Error ? retryError.message : String(retryError)}`, status, retryError);
      }
    }
  }

  private async requestOnce<T = unknown>(name: EndpointName | string, options: RequestOptions = {}): Promise<PortalResponse<T>> {
    if (!isEndpointName(name)) throw new JpdclError(`Unknown endpoint: ${name}`, 400);
    const endpoint = endpointCatalog[name];
    if (endpoint.portal !== "smart") throw new JpdclError(`${name} belongs to the main JPDCL portal`, 400);
    if (endpoint.mutation && !this.allowMutations) throw new MutationDisabledError();
    if (endpoint.auth === "smart-bearer" && !this.token) throw new AuthenticationError("A smart-meter bearer token is required");
    if (endpoint.auth === "smart-admin" && !this.adminToken) throw new AuthenticationError("JPDCL_SMART_ADMIN_TOKEN is required for this administrative endpoint");

    const url = buildUrl(this.baseUrl, endpoint.path, options.params);
    const portalOrigin = new URL(this.baseUrl).origin;
    const switchingAccount = name === "smart_switch_account";
    const headers: Record<string, string> = switchingAccount
      ? { Accept: "application/json", ...options.headers }
      : {
          Accept: endpoint.binary ? "*/*" : "application/json",
          "Accept-Language": "en_US",
          Referer: `${portalOrigin}/home`,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
          "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          ...options.headers,
        };
    if (!switchingAccount && endpoint.method !== "GET" && endpoint.method !== "DELETE") headers.Origin = portalOrigin;
    if (endpoint.auth === "smart-bearer" && this.token) headers.Authorization = `Bearer ${this.token}`;
    if (!switchingAccount && endpoint.auth === "smart-bearer" && this.effectiveTenantId) headers.TenantId = this.effectiveTenantId;
    if (endpoint.auth === "smart-admin" && this.adminToken) headers.Authorization = `Bearer ${this.adminToken}`;

    let body: string | undefined;
    if (options.body !== undefined && endpoint.method !== "GET" && endpoint.method !== "DELETE") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await this.smartFetch(url, { method: endpoint.method, headers, body });
    const contentType = response.headers.get("content-type") ?? "";
    if (endpoint.binary || !contentType.toLowerCase().includes("json")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw new JpdclError(`Smart-meter portal returned HTTP ${response.status}`, response.status, bytes.toString("utf8"));
      return { status: true, data: { base64: bytes.toString("base64"), contentType } as T };
    }

    const raw = (await response.json()) as PortalResponse<T> & { success?: boolean; error?: unknown };
    if (!response.ok || raw.success === false) {
      throw new JpdclError(errorMessage(raw) ?? `Smart-meter portal returned HTTP ${response.status}`, response.status || 502, raw);
    }
    return normalizeEnvelope(raw);
  }

  private async refreshAccountContext(): Promise<void> {
    const switching = this.accountSwitch ?? this.switchAccount(this.accountId, this.meterNumber);
    this.accountSwitch = switching;
    try {
      const switched = await switching;
      this.token = switched.bearerToken;
      this.claims = switched.claims;
      this.accountScoped = true;
    } finally {
      if (this.accountSwitch === switching) this.accountSwitch = undefined;
    }
  }

  async connections(): Promise<PortalResponse> {
    const accounts = this.accounts;
    const current = this.sessionInfo();
    return { status: true, data: accounts.length ? accounts : [current] };
  }

  async switchAccount(accountId = this.accountId, meterNumber = this.meterNumber): Promise<SmartMeterClient> {
    if (!this.token) throw new AuthenticationError("A smart-meter bearer token is required");
    const target = this.accounts.find((item) => accountId && item.kno === accountId)
      ?? this.accounts.find((item) => meterNumber && item.meterNo === meterNumber)
      ?? this.currentAccount;
    if (!target?.userId || !target.tenantId || !target.kno) {
      throw new JpdclError("The smart-meter SSO token did not include enough account context to switch accounts", 502);
    }
    if (accountId && target.kno !== accountId) {
      throw new JpdclError("The requested account is not present in the smart-meter SSO token", 403);
    }
    if (meterNumber && target.meterNo && target.meterNo !== meterNumber) {
      throw new JpdclError("The requested meter is not present in the smart-meter SSO token", 403);
    }

    // The Genus portal is behind a sticky AWS load balancer. A browser visits the
    // application before switching accounts and retains its AWSALB cookies. Keep
    // the same cookie jar here so the login-bypass and switch requests cannot be
    // split across backend sessions, which otherwise produces a misleading 403.
    await this.primePortal();

    const response = await this.request("smart_switch_account", {
      body: {
        tenantId: target.tenantId,
        userId: target.userId,
        uniqueId: target.uniqueId ?? target.userId,
        kno: target.kno,
        mobileNo: target.mobileNo,
        email: "",
        consumerName: target.consumerName,
        isPrimaryUser: target.isPrimaryUser,
        isRegistered: target.isRegistered,
        userTableId: target.userTableId,
        consumerId: target.consumerId,
      },
    });
    const data = objectRecord(response.data) ?? objectRecord(response) ?? {};
    const accessToken = claimString(data, "accessToken", "access_token");
    if (!accessToken) throw new JpdclError(response.message ?? "Account switch did not return a refreshed smart-meter token", 502, response);
    const claims = decodeJwt(accessToken);
    const selectedTenantId = claimString(claims, "currentAccountTenantId", "CurrentAccountTenantId", "tenantId", "TenantId")
      ?? claimString(data, "selectedTenantId")
      ?? target.tenantId;
    return new SmartMeterClient(accessToken, this.baseUrl, this.allowMutations, selectedTenantId, this.adminToken, true, this.smartFetch);
  }

  private async primePortal(): Promise<void> {
    this.portalPrime ??= (async () => {
      try {
        const response = await this.smartFetch(`${new URL(this.baseUrl).origin}/`, {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en_US",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
          },
        });
        await response.arrayBuffer();
      } catch {
        // Account switching still gets a chance when the optional portal warm-up fails.
      }
    })();
    await this.portalPrime;
  }

  async dashboard(accountId = this.accountId, options: { includeDerived?: boolean } = {}): Promise<PortalResponse> {
    if (!accountId) throw new JpdclError("Smart-meter account ID is required", 400);
    const meterNumber = this.meterNumber;
    if (!meterNumber) throw new JpdclError("Smart-meter number is required", 400);
    const calls: Record<string, Promise<PortalResponse>> = {
      usage: this.request("smart_today_monthly", { params: { meterNumber } }),
      currentMonth: this.request("smart_current_month", { params: { accountId } }),
      meterReadings: this.request("smart_meter_reading", { params: { meterNumber } }),
      reading: this.request("smart_current_meter_reading", { params: { accountId } }),
      lastBill: this.request("smart_postpaid_last_bill", { params: { accountId } }),
      billHistory: this.request("smart_postpaid_bill_history", { params: { accountId } }),
      paymentHistory: this.request("smart_postpaid_payment_history", { params: { accountId } }),
      meterDetails: this.request("smart_meter_details", { params: { meterNumber } }),
      preferences: this.request("smart_preferences", { params: { isPrepaid: booleanClaim(this.claims.currentAccountIsMeterPrepaid) ?? false } }),
      alerts: this.request("smart_my_alerts", { params: { accountId, meterNumber } }),
      onDemandRequests: this.request("smart_on_demand_logs", { params: { meterNumber } }),
    };
    const userId = this.currentUserId;
    if (userId) {
      calls.notifications = this.request("smart_notifications", { params: { userId } }).catch(() => ({ status: true, data: [] }));
      calls.unreadNotifications = this.request("smart_notification_unread_count", { params: { userId } }).catch(() => ({ status: true, data: { unreadCount: 0 } }));
    }
    if (booleanClaim(this.claims.currentAccountIsMeterPrepaid)) {
      delete calls.lastBill;
      delete calls.billHistory;
      delete calls.paymentHistory;
      calls.prepaidBalance = this.request("smart_prepaid_balance", { params: { meterNumber } });
      calls.rechargeBalance = this.request("smart_prepaid_recharge_balance", { params: { accountId } });
      calls.rechargeHistory = this.request("smart_prepaid_recharge_history", { params: { meterNumber } });
      calls.billHistory = this.request("smart_prepaid_bill_history", { params: { meterNumber } });
    }
    if (options.includeDerived) {
      calls.derivedInsights = this.request("smart_insights", { params: { accountId } });
      calls.derivedForecastToday = this.request("smart_forecast_today", { params: { meterNumber } });
      calls.derivedForecastWeekly = this.request("smart_forecast_weekly", { params: { meterNumber } });
      calls.derivedForecastMonthly = this.request("smart_forecast_monthly", { params: { meterNumber } });
    }
    const entries = await Promise.all(Object.entries(calls).map(async ([key, promise]) => {
      try { return [key, (await promise).data] as const; }
      catch (error) { return [key, { unavailable: true, message: error instanceof Error ? error.message : String(error) }] as const; }
    }));
    return {
      status: true,
      data: {
        _meta: options.includeDerived
          ? { dataPolicy: "observed-plus-derived", warning: "derivedInsights and derivedForecast* are predictions/advice, not meter evidence" }
          : { dataPolicy: "observed-only", derivedAndAdvisoryExcluded: true },
        session: this.sessionInfo(),
        ...Object.fromEntries(entries),
      },
    };
  }

  consumption(accountId = this.accountId, type = "monthly", value = 12): Promise<PortalResponse> {
    if (!accountId) throw new JpdclError("Smart-meter account ID is required", 400);
    if (!this.meterNumber) throw new JpdclError("Smart-meter number is required", 400);
    return this.request("smart_consumption_comparison", { params: { meterNumber: this.meterNumber, type, value } });
  }

  intervalConsumption(accountId: string | undefined, from: string, to: string, sortOrder = "date"): Promise<PortalResponse> {
    if (!(accountId ?? this.accountId)) throw new JpdclError("Smart-meter account ID is required", 400);
    if (!this.meterNumber) throw new JpdclError("Smart-meter number is required", 400);
    assertDateRange(from, to, { requireBoth: true });
    return this.request("smart_consumption_30min", { params: { meterNumber: this.meterNumber, fromDate: from, toDate: to, sortOrder } });
  }

  report(reportType: SmartReportType, accountId = this.accountId, options: SmartReportOptions = {}): Promise<PortalResponse> {
    if (!accountId) throw new JpdclError("Smart-meter account ID is required", 400);
    if (!this.meterNumber) throw new JpdclError("Smart-meter number is required", 400);
    assertDateRange(options.from, options.to, { pairedWhenPresent: true });
    const filter = options.filter ?? (options.from && options.to
      ? encodeReportFilter(options.from, options.to, options.start ?? 1, options.end ?? defaultReportEnd(reportType))
      : undefined);
    return this.request("smart_report", { params: { meterNumber: this.meterNumber, reportType, filter, format: options.format } });
  }
}

export type SmartReportType = "PowerOnOff" | "DayWiseTOD" | "MonthlyTOD" | "PeakSlotConsumption" |
  "PeakSlotConsumptionMonthly" | "ConsumerVoltageDataProfile" | "SanctionLoadVSMaxDemand";

export interface SmartReportOptions {
  from?: string;
  to?: string;
  start?: number;
  end?: number;
  filter?: string;
  format?: "xlsx" | "pdf";
}

export function encodeReportFilter(from: string, to: string, start = 1, end = 100): string {
  return Buffer.from(JSON.stringify({
    start,
    end,
    filters: { createdDateFrom: from, createdDateTo: to },
  }), "utf8").toString("base64");
}

export function smartApiUrlFromAppUrl(appUrl?: string): string {
  if (!appUrl) return SMART_API_URL;
  return new URL("/api", appUrl).toString().replace(/\/$/, "");
}

export function decodeJwt(token: string): SmartTokenClaims {
  try {
    const payload = token.split(".")[1];
    if (!payload) throw new Error("JWT payload is missing");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SmartTokenClaims;
  } catch (error) {
    throw new AuthenticationError("Invalid smart-meter SSO token", error);
  }
}

function normalizeEnvelope<T>(raw: PortalResponse<T> & { success?: boolean }): PortalResponse<T> {
  if (Object.prototype.hasOwnProperty.call(raw, "success")) {
    return { status: raw.success, message: raw.message, data: raw.data, correlationId: raw.correlationId };
  }
  return raw;
}

function errorMessage(value: Record<string, unknown>): string | undefined {
  const error = value.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return stringClaim(record.message) ?? stringClaim(record.title);
  }
  return stringClaim(value.message);
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function claimString(value: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const result = stringClaim(value[name]);
    if (result) return result;
  }
  return undefined;
}

function booleanClaim(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) return value.toLowerCase() === "true";
  return undefined;
}

function numberClaim(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeAccount(value: unknown): SmartAccount | undefined {
  const account = objectRecord(value);
  if (!account) return undefined;
  return {
    userId: claimString(account, "userId", "UserId"),
    uniqueId: claimString(account, "uniqueId", "UniqueId", "userId", "UserId"),
    tenantId: claimString(account, "tenantId", "TenantId"),
    mobileNo: claimString(account, "mobileNo", "MobileNo"),
    email: claimString(account, "email", "Email") ?? null,
    consumerName: claimString(account, "consumerName", "ConsumerName"),
    kno: claimString(account, "kno", "Kno"),
    meterNo: claimString(account, "meterNo", "MeterNo"),
    isMeterPrepaid: booleanClaim(account.isMeterPrepaid ?? account.IsMeterPrepaid),
    meteringMode: claimString(account, "meteringMode", "MeteringMode"),
    isRegistered: booleanClaim(account.isRegistered ?? account.IsRegistered),
    isPrimaryUser: booleanClaim(account.isPrimaryUser ?? account.IsPrimaryUser),
    userTableId: numberClaim(account.userTableId ?? account.UserTableId),
    consumerId: numberClaim(account.consumerId ?? account.ConsumerId),
    accountLabel: claimString(account, "accountLabel", "AccountLabel"),
    accountType: claimString(account, "accountType", "AccountType"),
  };
}

function accountFromClaims(claims: Record<string, unknown>): SmartAccount | undefined {
  const userId = claimString(claims, "currentAccountUserId", "CurrentAccountUserId", "currentQccountUserId", "sub", "userId", "UserId");
  const kno = claimString(claims, "currentAccountKno", "CurrentAccountKno", "kno", "Kno");
  if (!userId || !kno) return undefined;
  return {
    userId,
    uniqueId: userId,
    tenantId: claimString(claims, "currentAccountTenantId", "CurrentAccountTenantId", "tenantId", "TenantId"),
    mobileNo: claimString(claims, "currentAccountMobile", "CurrentAccountMobile", "mobileNo", "MobileNo"),
    email: claimString(claims, "currentAccountEmail", "CurrentAccountEmail", "email", "Email") ?? null,
    consumerName: claimString(claims, "currentAccountName", "CurrentAccountName", "name", "Name"),
    kno,
    meterNo: claimString(claims, "currentAccountMeterNo", "CurrentAccountMeterNo", "meterNo", "MeterNo"),
    isMeterPrepaid: booleanClaim(claims.currentAccountIsMeterPrepaid ?? claims.CurrentAccountIsMeterPrepaid),
    meteringMode: claimString(claims, "currentAccountMeteringMode", "CurrentAccountMeteringMode", "meteringMode", "MeteringMode"),
    isRegistered: true,
    isPrimaryUser: true,
    userTableId: 0,
    consumerId: 0,
    accountLabel: claimString(claims, "account_label", "accountLabel", "AccountLabel"),
    accountType: claimString(claims, "account_type", "accountType", "AccountType"),
  };
}

function parseAccounts(value: unknown): SmartAccount[] {
  let accounts: unknown[] = [];
  if (Array.isArray(value)) accounts = value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); accounts = Array.isArray(parsed) ? parsed : []; }
    catch { accounts = []; }
  }
  return accounts.map(normalizeAccount).filter((account): account is SmartAccount => Boolean(account?.userId));
}

function defaultReportEnd(reportType: SmartReportType): number {
  return reportType === "ConsumerVoltageDataProfile" ? 100 : reportType === "SanctionLoadVSMaxDemand" ? 12 : 10;
}
