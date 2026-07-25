#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { endpointCatalog, isEndpointName, listEndpoints } from "./catalog.js";
import { credentialStatus, storeEnvCredentials } from "./credentials.js";
import { assertDateRange, isIsoDate } from "./dates.js";
import { JpdclError } from "./errors.js";
import { JpdclRuntime } from "./runtime.js";
import { JPDCL_TARIFF_ORDER_2025_26 } from "./tariff.js";

const MCP_INSTRUCTIONS = `This server integrates Jammu Power Distribution Corporation Limited (JPDCL) consumer and smart-meter services. Use jpdcl_snapshot for a general account question. Use jpdcl_meter_health for supply, voltage, outages, alarms, or freshness; jpdcl_energy_ledger for dated import/export/net-import usage; jpdcl_tariff_estimate for provisional charges; and jpdcl_account_digest or billing tools for utility-issued bills and payments. WSS bills are authoritative for billed amounts. Genus supplies recent readings, voltage, intervals, and power events. The daily ledger supplies cumulative registers whose deltas are deterministic. Never describe a tariff estimate as an issued bill, or stale/on-demand data as a continuous live feed. Forecasts, recommendations, and smart tips are excluded unless explicitly requested. Use jpdcl_guide for the complete embedded decision guide and jpdcl_catalog only for uncommon raw fields. Mutations require explicit user intent and JPDCL_ENABLE_MUTATIONS=true.`;

const MCP_GUIDE = {
  preferredTools: {
    generalAccountState: "jpdcl_snapshot",
    supplyVoltageOutagesAndFreshness: "jpdcl_meter_health",
    importExportAndPeriodUsage: "jpdcl_energy_ledger",
    provisionalCharges: "jpdcl_tariff_estimate",
    officialBillsAndPayments: "jpdcl_account_digest",
    tariffRatesAndSource: "jpdcl_tariff_schedule",
    uncommonPortalField: "jpdcl_catalog then jpdcl_read",
  },
  sourceAuthority: [
    "WSS is authoritative for profile, sanctioned load, issued bills, billed units, payments, arrears, and account status.",
    "Genus supplies recent meter readings, voltage profiles, half-hour usage, power events, alerts, and meter metadata.",
    "The daily ledger supplies cumulative import/export/net-import kWh and kVAh; usage is derived only by register subtraction.",
    "The tariff engine is a deterministic calculation from the encoded official order, never a utility-issued bill.",
  ],
  tariffPolicy: {
    automaticUsage: "Prefer net-import register difference for a net meter; otherwise use import-register difference, with Genus current-month usage as fallback.",
    provisionalBecause: ["billing cutoffs", "export-credit settlement", "carry-forward balances", "duty", "adjustments", "later tariff revisions"],
    actualBillAuthority: "WSS billing records",
  },
  liveDataPolicy: "No consumer endpoint exposes a continuous stream or explicit communications-network online flag. Report each source timestamp and status separately.",
  defaultExclusions: ["forecasts", "recommendations", "energy-saving advice", "smart tips"],
  safety: "Consumer IDs, account IDs, meter numbers, readings, and bills are private. Mutations require explicit intent and JPDCL_ENABLE_MUTATIONS=true.",
} as const;

export async function createJpdclMcpServer(options: {
  runtime?: JpdclRuntime;
  allowCredentialStorage?: boolean;
  credentialSource?: string;
} = {}): Promise<McpServer> {
const server = new McpServer(
  { name: "JPDCL Smart Meter", version: "1.0.0" },
  { instructions: MCP_INSTRUCTIONS },
);
const runtime = options.runtime ?? await JpdclRuntime.create();
const isoDateSchema = z.string().refine(isIsoDate, "Use a real date in YYYY-MM-DD format");

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: toObject(value),
});

const run = async (operation: () => Promise<unknown>) => {
  try {
    return textResult(await operation());
  } catch (error) {
    const known = error instanceof JpdclError;
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: known ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          status: known ? error.status : 500,
          details: known ? error.details : undefined,
        }, null, 2),
      }],
    };
  }
};

server.registerTool("jpdcl_catalog", {
  title: "JPDCL API catalog",
  description: "List all mapped JPDCL WSS, Genus smart-meter, and daily import/export ledger endpoints, including required paths and whether an action mutates data.",
  inputSchema: { portal: z.enum(["main", "smart", "ledger"]).optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ portal }) => textResult(listEndpoints(portal)));

server.registerTool("jpdcl_guide", {
  title: "JPDCL AI operation guide",
  description: "Return the MCP's embedded source-selection, provenance, freshness, tariff, privacy, and safety rules. Use this when deciding which JPDCL tool answers a question.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => textResult(MCP_GUIDE));

server.registerTool("jpdcl_session_status", {
  title: "JPDCL session status",
  description: "Check whether the saved main and smart-meter API sessions are ready. Passwords are never returned.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const session = runtime.main.currentSession;
  const automatic = options.credentialSource
    ? { automaticRelogin: true, source: options.credentialSource, envFile: undefined }
    : await credentialStatus();
  return textResult({
    authenticated: Boolean(session),
    loginId: session?.loginId,
    primaryAccountId: session?.primaryAccountId,
    smartAuthenticated: Boolean(session?.smart?.token),
    smartExpiresAt: session?.smart?.expiresAt,
    automaticRelogin: automatic.automaticRelogin,
    credentialSource: automatic.source,
    credentialFile: automatic.envFile,
    updatedAt: session?.updatedAt,
  });
});

server.registerTool("jpdcl_auth_login", {
  title: "JPDCL first-time authentication",
  description: "Log in to JPDCL using credentials explicitly supplied by the user. Optionally saves them to the MCP project's private .env for automatic future main-portal re-login and smart-token renewal. The password is never returned.",
  inputSchema: {
    loginId: z.string().min(1).describe("JPDCL mobile number or email"),
    password: z.string().min(1).describe("JPDCL password"),
    saveToEnv: z.boolean().default(true).describe("Save locally to the git-ignored .env for unattended future authentication"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ loginId, password, saveToEnv }) => run(async () => {
  const result = await runtime.login(loginId, password);
  const savedTo = saveToEnv && options.allowCredentialStorage !== false
    ? await storeEnvCredentials(loginId, password)
    : undefined;
  return {
    authenticated: Boolean(result.status),
    message: result.message ?? "Login successful",
    credentialsSaved: Boolean(savedTo),
    credentialFile: savedTo,
    automaticRelogin: Boolean(savedTo),
    credentialManagement: options.allowCredentialStorage === false ? "connection-configuration" : "local-env",
  };
}));

server.registerTool("jpdcl_snapshot", {
  title: "JPDCL factual AI snapshot",
  description: "Preferred general-purpose tool: fetch one normalized, provenance-labelled snapshot combining billing records, Genus smart-meter data, the separate daily import/export register ledger, and a clearly labelled deterministic tariff estimate. Forecasts, recommendations, and smart tips are excluded.",
  inputSchema: { accountId: z.string().optional().describe("Defaults to the primary account") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => runtime.aiSnapshot(accountId)));

server.registerTool("jpdcl_tariff_estimate", {
  title: "JPDCL domestic tariff and charge estimate",
  description: "Automatically detect the account's domestic tariff and sanctioned load, prefer the current-period net-import ledger for a net meter, and calculate official FY 2025-26 slab and fixed charges. Optional government duty, arrears-related amounts and rebates are only applied when explicitly supplied. Returns measurement and tariff provenance.",
  inputSchema: {
    accountId: z.string().optional(),
    unitsKwh: z.number().nonnegative().optional().describe("Defaults to the best current-period measured quantity: net-import ledger for net meters, otherwise import/Genus usage"),
    sanctionedLoadKw: z.number().nonnegative().optional().describe("Defaults to the portal account load"),
    prepaid: z.boolean().optional().describe("Defaults from the portal plan"),
    solarWaterHeaterEligible: z.boolean().optional().describe("Apply Rs.150 only if JPDCL has verified eligibility"),
    electricityDutyAmount: z.number().nonnegative().optional().describe("Explicit amount; the tariff order does not define the levy rate"),
    otherChargesAmount: z.number().nonnegative().optional(),
    unpaidPrincipalAmount: z.number().nonnegative().optional(),
    lateMonths: z.number().nonnegative().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, ...overrides }) => run(async () => runtime.tariffEstimate(accountId, overrides)));

server.registerTool("jpdcl_tariff_schedule", {
  title: "JPDCL encoded FY 2025-26 tariff schedule",
  description: "Return the exact encoded domestic slabs, fixed charge, load rounding, rebates, late-payment rate, official PDF URL, and cited pages used by jpdcl_tariff_estimate.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => textResult(JPDCL_TARIFF_ORDER_2025_26));

server.registerTool("jpdcl_energy_ledger", {
  title: "JPDCL normalized daily energy ledger",
  description: "Fetch the separate smartmeter1 JPDCL ledger using the account's consumer ID automatically. Returns cumulative import/export/net-import kWh and kVAh, deterministic daily deltas, period totals, freshness, net-meter identity, and a provisional billing quantity with limitations.",
  inputSchema: {
    accountId: z.string().optional(),
    from: isoDateSchema.optional().describe("YYYY-MM-DD; defaults to the first day of the latest available month"),
    to: isoDateSchema.optional().describe("YYYY-MM-DD; defaults to the latest observation"),
    limit: z.number().int().nonnegative().max(500).default(35).describe("Daily rows to return; zero returns summary only"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, from, to, limit }) => run(async () => runtime.energyLedger(accountId, { from, to, limit })));

server.registerTool("jpdcl_meter_health", {
  title: "JPDCL unified meter and supply health",
  description: "Best status tool for AI: combine current electrical connection state, on-demand meter request state and values, voltage freshness, outage events, daily-ledger freshness, and alarm records. Explicitly distinguishes unavailable network connectivity from inferred data freshness.",
  inputSchema: { accountId: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => runtime.meterHealth(accountId)));

server.registerTool("jpdcl_account_info", {
  title: "JPDCL consumer account",
  description: "Get consumer profile, current bill, outstanding amount, meter, tariff, load, subdivision, and account-type details.",
  inputSchema: { accountId: z.string().optional().describe("10-digit account ID; defaults to the primary account") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => {
  await runtime.ensureLogin();
  const result = await runtime.main.customerInfo(accountId);
  await runtime.persist();
  return result;
}));

server.registerTool("jpdcl_account_digest", {
  title: "JPDCL complete account digest",
  description: "Return one digestible response combining profile, current bill, meter, billing history, payment history, consumption, and linked accounts.",
  inputSchema: { accountId: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => {
  await runtime.ensureLogin();
  const result = await runtime.main.digest(accountId);
  await runtime.persist();
  return result;
}));

for (const [toolName, type, title] of [
  ["jpdcl_bills", "BILL", "JPDCL billing history"],
  ["jpdcl_payments", "PAYM", "JPDCL payment history"],
] as const) {
  server.registerTool(toolName, {
    title,
    description: `Get ${type === "BILL" ? "bill assessments" : "payments and receipts"} for an account and date range (maximum six months per portal request).`,
    inputSchema: {
      accountId: z.string().optional(),
      from: isoDateSchema.optional().describe("YYYY-MM-DD"),
      to: isoDateSchema.optional().describe("YYYY-MM-DD"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ accountId, from, to }) => run(async () => {
    assertDateRange(from, to);
    await runtime.ensureLogin();
    return runtime.main.history(type, accountId, from, to);
  }));
}

server.registerTool("jpdcl_consumption", {
  title: "JPDCL consumption history",
  description: "Get billed import/export register readings and electricity consumption for an account and date range.",
  inputSchema: {
    accountId: z.string().optional(),
    from: isoDateSchema.optional().describe("YYYY-MM-DD"),
    to: isoDateSchema.optional().describe("YYYY-MM-DD"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, from, to }) => run(async () => {
  assertDateRange(from, to);
  await runtime.ensureLogin();
  return runtime.main.consumption(accountId, from, to);
}));

server.registerTool("jpdcl_smart_session", {
  title: "Smart-meter session and accounts",
  description: "Get current Genus SSO metadata: account, meter, plan, metering mode, tenant, token expiry, and linked smart accounts. This describes the session, not live electrical state.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => run(async () => (await runtime.ensureSmart()).connections()));

server.registerTool("jpdcl_smart_dashboard", {
  title: "Smart-meter factual data digest",
  description: "Get measured readings and account records. Predictions, recommendations, estimates, and smart tips are excluded unless includeDerived is explicitly true.",
  inputSchema: {
    accountId: z.string().optional().describe("Defaults to the SSO account"),
    includeDerived: z.boolean().default(false).describe("Opt in to clearly labelled forecasts/insights/tips that are not meter evidence"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, includeDerived }) => run(async () =>
  (await runtime.ensureSmart(accountId)).dashboard(accountId, { includeDerived })));

server.registerTool("jpdcl_smart_consumption", {
  title: "Smart-meter recorded consumption",
  description: "Get the utility's current today/month consumption feed used by the Genus portal together with a daily, weekly, or monthly comparison. It excludes on-demand readings and forecasts; timestamps determine freshness.",
  inputSchema: {
    accountId: z.string().optional(),
    type: z.enum(["daily", "weekly", "monthly"]).default("monthly"),
    value: z.number().int().positive().max(366).default(12),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, type, value }) => run(async () =>
  runtime.smartConsumption(accountId, type, value)));

server.registerTool("jpdcl_smart_intervals", {
  title: "Smart-meter half-hour readings",
  description: "Get half-hour import/export readings over an ISO date range.",
  inputSchema: {
    accountId: z.string().optional(),
    from: isoDateSchema.describe("YYYY-MM-DD"),
    to: isoDateSchema.describe("YYYY-MM-DD"),
    sortOrder: z.string().default("date"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, from, to, sortOrder }) => run(async () => {
  assertDateRange(from, to, { requireBoth: true });
  return (await runtime.ensureSmart(accountId)).intervalConsumption(accountId, from, to, sortOrder);
}));

server.registerTool("jpdcl_smart_meter_profile", {
  title: "Smart-meter technical profile",
  description: "Get the live portal's meter and connection data: phase, metering mode, manufacturer, voltage, sanctioned load, SDO, installation date, address, tariff, and current reading.",
  inputSchema: { accountId: z.string().optional(), meterNumber: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, meterNumber }) => run(async () => {
  const client = await runtime.ensureSmart(accountId, meterNumber);
  const meter = meterNumber ?? client.meterNumber;
  const account = accountId ?? client.accountId;
  if (!meter || !account) throw new JpdclError("Account ID and meter number are required", 400);
  const [details, reading] = await Promise.all([
    client.request("smart_meter_details", { params: { meterNumber: meter } }),
    client.request("smart_current_meter_reading", { params: { accountId: account } }),
  ]);
  return { details: details.data, currentReading: reading.data };
}));

server.registerTool("jpdcl_smart_forecasts", {
  title: "Smart-meter derived forecasts and advice",
  description: "Explicitly fetch predictions, estimates, comparisons, savings suggestions, and smart tips. These are derived/advisory outputs and must not be presented as measured facts.",
  inputSchema: { accountId: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => {
  const client = await runtime.ensureSmart(accountId);
  if (!client.meterNumber || !client.accountId) throw new JpdclError("Smart account is incomplete", 400);
  const [today, weekly, monthly, insights] = await Promise.all([
    client.request("smart_forecast_today", { params: { meterNumber: client.meterNumber } }),
    client.request("smart_forecast_weekly", { params: { meterNumber: client.meterNumber } }),
    client.request("smart_forecast_monthly", { params: { meterNumber: client.meterNumber } }),
    client.request("smart_insights", { params: { accountId: client.accountId } }),
  ]);
  return {
    _meta: {
      dataClass: "derived-and-advisory",
      warning: "Predictions, estimates, comparisons, savings suggestions, and smart tips are not meter evidence.",
    },
    today: today.data,
    weekly: weekly.data,
    monthly: monthly.data,
    insights: insights.data,
  };
}));

server.registerTool("jpdcl_smart_billing", {
  title: "Smart-meter billing and payment history",
  description: "Get the correct postpaid bills/payments or prepaid balance/recharges/bills for the current plan.",
  inputSchema: { accountId: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => {
  const client = await runtime.ensureSmart(accountId);
  if (!client.accountId || !client.meterNumber) throw new JpdclError("Smart account is incomplete", 400);
  const prepaid = String(client.claims.currentAccountIsMeterPrepaid).toLowerCase() === "true";
  if (prepaid) {
    const [balance, rechargeBalance, recharges, bills] = await Promise.all([
      client.request("smart_prepaid_balance", { params: { meterNumber: client.meterNumber } }),
      client.request("smart_prepaid_recharge_balance", { params: { accountId: client.accountId } }),
      client.request("smart_prepaid_recharge_history", { params: { meterNumber: client.meterNumber } }),
      client.request("smart_prepaid_bill_history", { params: { meterNumber: client.meterNumber } }),
    ]);
    return { plan: "prepaid", balance: balance.data, rechargeBalance: rechargeBalance.data, recharges: recharges.data, bills: bills.data };
  }
  const [lastBill, bills, payments] = await Promise.all([
    client.request("smart_postpaid_last_bill", { params: { accountId: client.accountId } }),
    client.request("smart_postpaid_bill_history", { params: { accountId: client.accountId } }),
    client.request("smart_postpaid_payment_history", { params: { accountId: client.accountId } }),
  ]);
  return { plan: "postpaid", lastBill: lastBill.data, bills: bills.data, payments: payments.data };
}));

server.registerTool("jpdcl_smart_alerts", {
  title: "Smart-meter usage alerts",
  description: "Get live consumption and configured daily/monthly alert thresholds and descriptions.",
  inputSchema: { accountId: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => {
  const client = await runtime.ensureSmart(accountId);
  if (!client.accountId || !client.meterNumber) throw new JpdclError("Smart account is incomplete", 400);
  return client.request("smart_my_alerts", { params: { accountId: client.accountId, meterNumber: client.meterNumber } });
}));

server.registerTool("jpdcl_smart_preferences", {
  title: "Smart-meter notification preferences",
  description: "Get every notification category and channel switch shown on the live accounts page.",
  inputSchema: { accountId: z.string().optional(), isPrepaid: z.boolean().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, isPrepaid }) => run(async () => {
  const client = await runtime.ensureSmart(accountId);
  const plan = isPrepaid ?? String(client.claims.currentAccountIsMeterPrepaid).toLowerCase() === "true";
  return client.request("smart_preferences", { params: { isPrepaid: plan } });
}));

server.registerTool("jpdcl_smart_support", {
  title: "Smart-meter support center",
  description: "Get FAQs, contact details, complaint categories, and the current user's complaint list.",
  inputSchema: { accountId: z.string().optional(), pageNumber: z.number().int().positive().default(1), pageSize: z.number().int().positive().max(100).default(20), statusCodes: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, pageNumber, pageSize, statusCodes }) => run(async () => {
  const client = await runtime.ensureSmart(accountId);
  const userId = typeof client.claims.sub === "string" ? client.claims.sub : undefined;
  if (!userId) throw new JpdclError("Smart user ID is unavailable", 400);
  const [faqs, contact, categories, complaints] = await Promise.all([
    client.request("smart_faqs"),
    client.request("smart_contact_support").catch(() => ({ status: true, data: null })),
    client.request("smart_complaint_categories"),
    client.request("smart_complaints", { params: { userId, pageNumber, pageSize, statusCodes } }),
  ]);
  return {
    _meta: { dataClass: "mixed", advisoryFields: ["faqs"], observedFields: ["complaints"], configurationFields: ["contact", "categories"] },
    faqs: faqs.data,
    contact: contact.data,
    categories: categories.data,
    complaints: complaints.data,
  };
}));

server.registerTool("jpdcl_smart_notifications", {
  title: "Smart-meter notifications",
  description: "Get smart-portal notifications and the unread count for the current user.",
  inputSchema: { accountId: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => run(async () => {
  const client = await runtime.ensureSmart(accountId);
  const userId = typeof client.claims.sub === "string" ? client.claims.sub : undefined;
  if (!userId) throw new JpdclError("Smart user ID is unavailable", 400);
  const [items, unread] = await Promise.all([
    client.request("smart_notifications", { params: { userId } }).catch(() => ({ status: true, data: [] })),
    client.request("smart_notification_unread_count", { params: { userId } }).catch(() => ({ status: true, data: { unreadCount: 0 } })),
  ]);
  return { items: items.data, unread: unread.data };
}));

server.registerTool("jpdcl_smart_nearby_offices", {
  title: "Nearby JPDCL offices",
  description: "Find nearby service offices using latitude, longitude, and a search query. If JPDCL's office service is unavailable, returns a structured unavailable result rather than inventing locations.",
  inputSchema: { latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), query: z.string().min(1).default("JPDCL") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ latitude, longitude, query }) => run(async () => {
  const client = await runtime.ensureSmart();
  try {
    return await client.request("smart_nearby_offices", { params: { lat: latitude, lng: longitude, query: query || "JPDCL" } });
  } catch (error) {
    if (!(error instanceof JpdclError)) throw error;
    return {
      _meta: {
        dataClass: "observed-service-status",
        source: "smart_nearby_offices",
        available: false,
        checkedAt: new Date().toISOString(),
      },
      offices: [],
      error: { status: error.status, message: error.message },
      warning: "The JPDCL office service is currently unavailable; no office locations were inferred or fabricated.",
    };
  }
}));

server.registerTool("jpdcl_smart_report", {
  title: "Smart-meter analytical report",
  description: "Get monthly/daily TOD, power event, peak-slot, voltage, or sanctioned-load-versus-demand reports.",
  inputSchema: {
    accountId: z.string().optional(),
    report: z.enum(["monthly_tod", "daily_tod", "power_events", "peak_slots", "peak_monthly", "voltage", "demand"]),
    from: isoDateSchema.optional().describe("YYYY-MM-DD; supply both from and to, or neither"),
    to: isoDateSchema.optional().describe("YYYY-MM-DD; supply both from and to, or neither"),
    start: z.number().int().positive().default(1),
    end: z.number().int().positive().optional(),
    filter: z.string().optional().describe("Advanced: pre-encoded portal report filter"),
    format: z.enum(["xlsx", "pdf"]).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId, report, from, to, start, end, filter, format }) => run(async () => {
  assertDateRange(from, to, { pairedWhenPresent: true });
  const names = {
    monthly_tod: "MonthlyTOD",
    daily_tod: "DayWiseTOD",
    power_events: "PowerOnOff",
    peak_slots: "PeakSlotConsumption",
    peak_monthly: "PeakSlotConsumptionMonthly",
    voltage: "ConsumerVoltageDataProfile",
    demand: "SanctionLoadVSMaxDemand",
  } as const;
  return runtime.smartReport(accountId, names[report], { from, to, start, end, filter, format });
}));

server.registerTool("jpdcl_read", {
  title: "Any JPDCL read endpoint",
  description: "Call any non-mutating endpoint from jpdcl_catalog. Derived/advisory endpoints require an explicit allowDerived opt-in.",
  inputSchema: {
    endpoint: z.string().describe("Catalog endpoint name"),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
    allowDerived: z.boolean().default(false).describe("Required for endpoints classified as derived or advisory"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ endpoint, params, body, allowDerived }) => run(async () => {
  if (!isEndpointName(endpoint)) throw new JpdclError(`Unknown endpoint: ${endpoint}`, 400);
  const definition = endpointCatalog[endpoint];
  if (definition.mutation) throw new JpdclError("Use jpdcl_mutate for mutating endpoints", 400);
  if (["derived", "advisory"].includes(definition.dataClass ?? "") && !allowDerived) {
    throw new JpdclError(`${endpoint} is classified as ${definition.dataClass}; set allowDerived=true to request non-factual content`, 400);
  }
  await runtime.ensureLogin();
  return definition.portal === "main"
    ? runtime.main.request(endpoint, { params, body })
    : definition.portal === "smart"
      ? (await runtime.ensureSmart()).request(endpoint, { params, body })
      : runtime.ledger.request(endpoint, { params, body });
}));

server.registerTool("jpdcl_mutate", {
  title: "JPDCL account action",
  description: "Call a cataloged account-changing API such as linking an account, updating contacts/preferences, registering a complaint, or creating a payment intent. Requires both JPDCL_ENABLE_MUTATIONS=true and confirm=true after explicit user approval.",
  inputSchema: {
    endpoint: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
    confirm: z.boolean().default(false).describe("Must be true to confirm the named account-changing operation"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ endpoint, params, body, confirm }) => run(async () => {
  if (!isEndpointName(endpoint)) throw new JpdclError(`Unknown endpoint: ${endpoint}`, 400);
  const definition = endpointCatalog[endpoint];
  if (!definition.mutation) throw new JpdclError("This endpoint is read-only; use jpdcl_read", 400);
  if (definition.portal === "ledger") throw new JpdclError("The daily meter ledger exposes no mutating operations", 400);
  if (!confirm) throw new JpdclError("Set confirm=true only after the user explicitly approves this exact action", 400);
  await runtime.ensureLogin();
  const result = definition.portal === "main"
    ? await runtime.main.request(endpoint, { params, body })
    : await (await runtime.ensureSmart()).request(endpoint, { params, body });
  await runtime.persist();
  return result;
}));

server.registerResource("jpdcl-api-catalog", "jpdcl://catalog", {
  title: "JPDCL API catalog",
  description: "Complete discovered JPDCL and smart-meter endpoint registry",
  mimeType: "application/json",
}, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(listEndpoints(), null, 2) }],
}));

server.registerResource("jpdcl-embedded-guide", "jpdcl://guide", {
  title: "JPDCL AI operation guide",
  description: "Embedded source-selection, provenance, tariff, freshness, and safety manual",
  mimeType: "application/json",
}, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(MCP_GUIDE, null, 2) }],
}));

return server;
}

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
