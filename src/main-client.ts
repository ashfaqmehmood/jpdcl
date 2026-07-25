import { endpointCatalog, isEndpointName, type EndpointName } from "./catalog.js";
import { LOGIN_CREDENTIAL_HEADER, MAIN_API_URL, PORTAL_BASIC, mutationsEnabled } from "./config.js";
import { decryptPayload, encryptPayload } from "./crypto.js";
import { assertDateRange } from "./dates.js";
import { resolveCredentials, type Credentials } from "./credentials.js";
import { AuthenticationError, JpdclError, MutationDisabledError } from "./errors.js";
import { basicAuth, buildUrl, CookieHttpClient } from "./http.js";
import type { MainSession, PortalResponse, RequestOptions } from "./types.js";
import { saveSession } from "./session.js";

function truthyStatus(status: unknown): boolean {
  return status === true || status === 1 || status === "1" || status === "true" || status === "Success" || status === "0";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class JpdclClient {
  private readonly http: CookieHttpClient;
  private session?: MainSession;

  constructor(
    session?: MainSession,
    private readonly baseUrl = MAIN_API_URL,
    private readonly allowMutations = mutationsEnabled(),
    private readonly suppliedCredentials?: Credentials,
    private readonly persistSession: (session: MainSession) => Promise<void> = saveSession,
  ) {
    this.session = session;
    this.http = new CookieHttpClient(session?.cookies);
  }

  get currentSession(): MainSession | undefined {
    if (!this.session) return undefined;
    return { ...this.session, cookies: this.http.serialize(), updatedAt: new Date().toISOString() };
  }

  async login(loginId: string, password: string): Promise<PortalResponse> {
    if (!loginId || !password) throw new AuthenticationError("Login ID and password are required");
    const response = await this.http.fetch(buildUrl(this.baseUrl, "/userLoginWebNew"), {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: basicAuth(PORTAL_BASIC),
        [LOGIN_CREDENTIAL_HEADER]: Buffer.from(`${loginId}:${password}`, "utf8").toString("base64"),
      },
    });
    const decoded = await this.decodeResponse(response);
    if (!response.ok || !truthyStatus(decoded.status)) {
      throw new AuthenticationError(decoded.message ?? `Login failed with HTTP ${response.status}`, decoded);
    }

    const data = asRecord(decoded.data) ?? {};
    const now = new Date().toISOString();
    this.session = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      cookies: this.http.serialize(),
      loginId: String(data.login_id ?? loginId),
      primaryAccountId: data.primary_acc_number ? String(data.primary_acc_number) : undefined,
      user: data,
    };
    return decoded;
  }

  async request<T = unknown>(name: EndpointName | string, options: RequestOptions = {}): Promise<PortalResponse<T>> {
    return this.requestInternal<T>(name, options, false);
  }

  private async requestInternal<T>(name: EndpointName | string, options: RequestOptions, retriedAuthentication: boolean): Promise<PortalResponse<T>> {
    if (!isEndpointName(name)) throw new JpdclError(`Unknown endpoint: ${name}`, 400);
    const endpoint = endpointCatalog[name];
    if (endpoint.portal !== "main") throw new JpdclError(`${name} belongs to the smart-meter portal`, 400);
    if (endpoint.mutation && !this.allowMutations) throw new MutationDisabledError();
    if (name === "main_login") throw new JpdclError("Use login() for consumer authentication", 400);
    if (endpoint.auth === "main-session" && !this.session) throw new AuthenticationError();

    const url = buildUrl(this.baseUrl, endpoint.path, options.params);
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      ...options.headers,
    };
    if (endpoint.auth === "public-basic" || endpoint.auth === "external-basic") {
      headers.Authorization = basicAuth(PORTAL_BASIC);
    }

    let body: string | undefined;
    if (endpoint.method !== "GET" && endpoint.method !== "DELETE") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(endpoint.encrypted === false ? (options.body ?? {}) : encryptPayload(options.body ?? {}));
    }

    const response = await this.http.fetch(url, { method: endpoint.method, headers, body });
    const decoded = await this.decodeResponse<T>(response);
    if (!retriedAuthentication && endpoint.auth === "main-session" && isAuthenticationFailure(response.status, decoded)) {
      const credentials = this.suppliedCredentials ?? await resolveCredentials();
      if (credentials) {
        const smartSession = this.session?.smart;
        await this.login(credentials.loginId, credentials.password);
        if (this.session && smartSession) this.session.smart = smartSession;
        const refreshedSession = this.currentSession;
        if (refreshedSession) await this.persistSession(refreshedSession);
        return this.requestInternal<T>(name, options, true);
      }
    }
    if (!response.ok) throw new JpdclError(decoded.message ?? `JPDCL returned HTTP ${response.status}`, response.status, decoded);
    return decoded;
  }

  private async decodeResponse<T = unknown>(response: Response): Promise<PortalResponse<T>> {
    const text = await response.text();
    if (!text) return { status: response.ok };
    try {
      return decryptPayload<PortalResponse<T>>(text);
    } catch (decryptError) {
      try {
        return JSON.parse(text) as PortalResponse<T>;
      } catch {
        throw new JpdclError("JPDCL returned an unreadable response", response.status, {
          contentType: response.headers.get("content-type"),
          decryptError: (decryptError as Error).message,
        });
      }
    }
  }

  async customerInfo(accountId = this.session?.primaryAccountId): Promise<PortalResponse> {
    if (!accountId) throw new JpdclError("An account ID is required", 400);
    const result = await this.request("main_customer_info", { body: { accountid: accountId } });
    const record = asRecord(result.data);
    if (record && this.session) {
      this.session.consumerCode = record.consumerID ? String(record.consumerID) : this.session.consumerCode;
    }
    return result;
  }

  async linkedAccounts(loginId = this.session?.loginId): Promise<PortalResponse> {
    if (!loginId) throw new JpdclError("A login ID is required", 400);
    return this.request("main_linked_accounts", { body: { loginid: loginId } });
  }

  async history(
    type: "BILL" | "PAYM",
    accountId = this.session?.primaryAccountId,
    from = sixMonthsAgo(),
    to = isoDate(new Date()),
  ): Promise<PortalResponse> {
    if (!accountId) throw new JpdclError("An account ID is required", 400);
    assertDateRange(from, to, { requireBoth: true });
    return this.request("main_bill_history", {
      body: { acct_id: accountId, type, st_dt: from, en_dt: to },
    });
  }

  async consumption(
    accountId = this.session?.primaryAccountId,
    from = sixMonthsAgo(),
    to = isoDate(new Date()),
  ): Promise<PortalResponse> {
    if (!accountId) throw new JpdclError("An account ID is required", 400);
    assertDateRange(from, to, { requireBoth: true });
    return this.request("main_consumption", {
      body: { accountid: accountId, fromdate: from, todate: to },
    });
  }

  async smartSso(accountId: string, meterNumber: string): Promise<PortalResponse> {
    return this.request("main_smart_sso", { body: { accountId, mtrno: meterNumber } });
  }

  async digest(accountId = this.session?.primaryAccountId): Promise<Record<string, unknown>> {
    if (!accountId) throw new JpdclError("An account ID is required", 400);
    const customer = await this.customerInfo(accountId);
    const optional = await Promise.all([
      capturePortal("bills", this.history("BILL", accountId)),
      capturePortal("payments", this.history("PAYM", accountId)),
      capturePortal("consumption", this.consumption(accountId)),
      capturePortal("linkedAccounts", this.linkedAccounts()),
    ]);
    const [bills, payments, consumption, linked] = optional;
    const customerData = asRecord(customer.data) ?? {};
    return {
      _meta: {
        dataClass: "observed-account-and-billing-records",
        source: "jpdcl-wss",
        sourceErrors: optional.filter((result) => !result.ok).map((result) => ({ source: result.source, message: result.error })),
      },
      generatedAt: new Date().toISOString(),
      accountId,
      consumer: customerData,
      currentBill: customerData.billDetails ?? customerData.currentBill ?? null,
      meter: {
        number: customerData.mtrSrNum ?? customerData.meterNo ?? customerData.meterNumber,
        accountType: customerData.postOrPre ?? customerData.accountType,
        netMetering: customerData.isNetMtrAcct,
      },
      bills: bills.ok ? bills.value.data ?? [] : [],
      payments: payments.ok ? payments.value.data ?? [] : [],
      consumption: consumption.ok ? consumption.value.data ?? [] : [],
      linkedAccounts: linked.ok ? linked.value.data ?? [] : [],
    };
  }
}

async function capturePortal(source: string, promise: Promise<PortalResponse>): Promise<
  { ok: true; source: string; value: PortalResponse } | { ok: false; source: string; error: string }
> {
  try { return { ok: true, source, value: await promise }; }
  catch (error) { return { ok: false, source, error: error instanceof Error ? error.message : String(error) }; }
}

function isAuthenticationFailure(httpStatus: number, response: PortalResponse): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  const message = String(response.message ?? "").toLowerCase();
  return ["unauthor", "session expired", "login again", "not authenticated"].some((marker) => message.includes(marker));
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function sixMonthsAgo(): string {
  const date = new Date();
  date.setMonth(date.getMonth() - 6);
  return isoDate(date);
}
