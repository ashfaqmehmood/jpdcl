import { JpdclRuntime } from "../src/runtime.js";
import { decodeJwt, SmartMeterClient, smartApiUrlFromAppUrl } from "../src/smart-client.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function claim(value: UnknownRecord, ...names: string[]): string | undefined {
  for (const name of names) {
    const result = text(value[name]);
    if (result) return result;
  }
  return undefined;
}

function accountsFromClaims(claims: UnknownRecord): UnknownRecord[] {
  const value = claims.userAccounts ?? claims.UserAccounts ?? claims.accounts ?? claims.user_accounts;
  if (Array.isArray(value)) return value.map(record).filter((item): item is UnknownRecord => Boolean(item));
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(record).filter((item): item is UnknownRecord => Boolean(item)) : [];
  } catch {
    return [];
  }
}

function accountValue(account: UnknownRecord, camel: string, pascal: string): unknown {
  return account[camel] ?? account[pascal];
}

function switchBody(account: UnknownRecord): UnknownRecord {
  return {
    tenantId: accountValue(account, "tenantId", "TenantId"),
    userId: accountValue(account, "userId", "UserId"),
    uniqueId: accountValue(account, "uniqueId", "UniqueId") ?? accountValue(account, "userId", "UserId"),
    kno: accountValue(account, "kno", "Kno"),
    mobileNo: accountValue(account, "mobileNo", "MobileNo"),
    email: "",
    consumerName: accountValue(account, "consumerName", "ConsumerName"),
    isPrimaryUser: accountValue(account, "isPrimaryUser", "IsPrimaryUser"),
    isRegistered: accountValue(account, "isRegistered", "IsRegistered"),
    userTableId: accountValue(account, "userTableId", "UserTableId"),
    consumerId: accountValue(account, "consumerId", "ConsumerId"),
  };
}

function currentAccountFromClaims(claims: UnknownRecord): UnknownRecord | undefined {
  const userId = claim(claims, "currentAccountUserId", "CurrentAccountUserId", "currentQccountUserId", "sub", "userId", "UserId");
  const kno = claim(claims, "currentAccountKno", "CurrentAccountKno", "kno", "Kno");
  if (!userId || !kno) return undefined;
  return {
    userId,
    uniqueId: userId,
    tenantId: claim(claims, "currentAccountTenantId", "CurrentAccountTenantId", "tenantId", "TenantId"),
    mobileNo: claim(claims, "currentAccountMobile", "CurrentAccountMobile", "mobileNo", "MobileNo"),
    consumerName: claim(claims, "currentAccountName", "CurrentAccountName", "name", "Name"),
    kno,
    meterNo: claim(claims, "currentAccountMeterNo", "CurrentAccountMeterNo", "meterNo", "MeterNo"),
    isPrimaryUser: true,
    isRegistered: true,
    userTableId: 0,
    consumerId: 0,
  };
}

async function probe(client: SmartMeterClient): Promise<UnknownRecord> {
  const accountId = client.accountId;
  const meterNumber = client.meterNumber;
  if (!accountId || !meterNumber) return { ok: false, reason: "account or meter number unavailable" };
  const userId = client.currentUserId;
  const calls: Record<string, Promise<unknown>> = {
    todayMonthly: client.request("smart_today_monthly", { params: { meterNumber } }),
    currentMonth: client.request("smart_current_month", { params: { accountId } }),
    meterReading: client.request("smart_meter_reading", { params: { meterNumber } }),
    currentReading: client.request("smart_current_meter_reading", { params: { accountId } }),
    meterDetails: client.request("smart_meter_details", { params: { meterNumber } }),
    alerts: client.request("smart_my_alerts", { params: { accountId, meterNumber } }),
    billHistory: client.request("smart_postpaid_bill_history", { params: { accountId } }),
    preferences: client.request("smart_preferences", { params: { isPrepaid: client.currentAccount?.isMeterPrepaid ?? false } }),
  };
  if (userId) calls.notifications = client.request("smart_notifications", { params: { userId } });
  const entries = await Promise.all(Object.entries(calls).map(async ([name, call]) => {
    try {
      const response = await call as { status?: unknown };
      return [name, { ok: true, applicationStatus: response.status ?? null }] as const;
    } catch (error) {
      return [name, {
        ok: false,
        httpStatus: typeof error === "object" && error && "status" in error ? (error as { status?: unknown }).status ?? null : null,
        message: error instanceof Error ? error.message : String(error),
      }] as const;
    }
  }));
  return Object.fromEntries(entries);
}

const loginId = process.env.JPDCL_LOGIN_ID;
const password = process.env.JPDCL_PASSWORD;
const runtime = await JpdclRuntime.create(loginId && password ? {
  credentials: { loginId, password },
  persistent: false,
  allowMutations: false,
} : {
  persistent: true,
  allowMutations: false,
});
await runtime.ensureLogin();
const accountId = runtime.main.currentSession?.primaryAccountId;
if (!accountId) throw new Error("The work login did not return a primary account");
const customer = record((await runtime.main.customerInfo(accountId)).data) ?? {};
const meterNumber = text(customer.mtrSrNum ?? customer.meterNumber ?? customer.meterNo);
if (!meterNumber) throw new Error("The account did not return a meter number");

const sso = await runtime.main.smartSso(accountId, meterNumber);
const ssoData = record(sso.data) ?? {};
const initialToken = text(ssoData.jwt);
if (!initialToken) throw new Error("JPDCL did not issue a smart-meter SSO token");
const appUrl = text(ssoData.app_url);
const baseUrl = smartApiUrlFromAppUrl(appUrl);
const initialClaims = decodeJwt(initialToken);
const accounts = accountsFromClaims(initialClaims);
const currentAccount = claim(initialClaims, "currentAccountKno", "CurrentAccountKno", "kno", "Kno");
const currentMeter = claim(initialClaims, "currentAccountMeterNo", "CurrentAccountMeterNo", "meterNo", "MeterNo");
const target = accounts.find((item) => claim(item, "kno", "Kno") === accountId)
  ?? accounts.find((item) => claim(item, "meterNo", "MeterNo") === meterNumber)
  ?? accounts[0]
  ?? currentAccountFromClaims(initialClaims);
if (!target) throw new Error("The SSO token did not include a switchable account");

const initialClient = new SmartMeterClient(initialToken, baseUrl, false, claim(initialClaims, "currentAccountTenantId", "CurrentAccountTenantId", "tenantId", "TenantId"));
const initialProbe = await probe(initialClient);

const switchResponse = await fetch(`${baseUrl}/Authentication/switch-account`, {
  method: "POST",
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${initialToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(switchBody(target)),
});
const switchEnvelope = record(await switchResponse.json().catch(() => ({}))) ?? {};
const switchData = record(switchEnvelope.data) ?? switchEnvelope;
const switchedToken = text(switchData.accessToken ?? switchData.access_token);
const switchedClaims = switchedToken ? decodeJwt(switchedToken) : undefined;
const switchedClient = switchedToken
  ? new SmartMeterClient(switchedToken, baseUrl, false, claim(switchedClaims ?? {}, "currentAccountTenantId", "CurrentAccountTenantId", "tenantId", "TenantId"))
  : undefined;

const result = {
  initial: {
    tokenType: claim(initialClaims, "tokenType", "TokenType") ?? null,
    accountMatches: currentAccount === accountId,
    meterMatches: currentMeter === meterNumber,
    linkedAccountCount: accounts.length,
    endpoint: initialProbe,
  },
  accountSwitch: {
    httpStatus: switchResponse.status,
    success: switchEnvelope.success ?? switchResponse.ok,
    tokenIssued: Boolean(switchedToken),
    tokenChanged: Boolean(switchedToken && switchedToken !== initialToken),
    responseFields: Object.keys(switchData).filter((key) => !/token/i.test(key)).sort(),
  },
  switched: switchedClient ? {
    accountMatches: switchedClient.accountId === accountId,
    meterMatches: switchedClient.meterNumber === meterNumber,
    endpoint: await probe(switchedClient),
  } : null,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
