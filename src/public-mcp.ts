import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { endpointCatalog, isEndpointName, listEndpoints } from "./catalog.js";
import { assertDateRange, isIsoDate } from "./dates.js";
import { JpdclError } from "./errors.js";
import { MCP_GUIDE } from "./guide.js";
import { JpdclRuntime } from "./runtime.js";
import { JPDCL_TARIFF_ORDER_2025_26 } from "./tariff.js";

const PUBLIC_INSTRUCTIONS = `Read-only, independent JPDCL account access. Use jpdcl_account_digest for general account questions, jpdcl_smart_consumption for the Genus portal's current today/month values and comparisons, jpdcl_smart_report for complete dated analytical reports, jpdcl_energy_ledger for dated import/export registers, jpdcl_tariff_estimate for provisional charges, and billing tools for utility-issued bills and payments. Use jpdcl_catalog then jpdcl_read only for uncommon fields. Never describe an estimate as an issued bill or delayed readings as a live feed. Authentication happens only through OAuth account linking; never ask for or accept a JPDCL password in chat. This hosted server is strictly read-only.`;
const OUTPUT_SCHEMA = { result: z.unknown() };
const READ_EXTERNAL = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const READ_LOCAL = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function createJpdclPublicMcpServer(
  runtime: JpdclRuntime,
  options: { includeSmartTools?: boolean } = {},
): McpServer {
  const server = new McpServer(
    { name: "JPDCL Smart Meter (Unofficial)", version: "1.0.0" },
    {
      instructions: options.includeSmartTools
        ? `${PUBLIC_INSTRUCTIONS} Use jpdcl_snapshot for a combined billing and smart-meter overview, and jpdcl_meter_health for supply, voltage, outage, alarm, and freshness questions.`
        : `${PUBLIC_INSTRUCTIONS} This deployment omits Genus-dependent smart-meter tools because its upstream egress is unavailable.`,
    },
  );
  const isoDateSchema = z.string().refine(isIsoDate, "Use a real date in YYYY-MM-DD format");

  const textResult = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
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
          }, null, 2),
        }],
      };
    }
  };

  server.registerTool("jpdcl_catalog", {
    title: "JPDCL API catalog",
    description: "List all mapped read-only and mutating JPDCL endpoints. Use jpdcl_read only with entries whose mutation field is false.",
    inputSchema: { portal: z.enum(["main", "smart", "ledger"]).optional() },
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_LOCAL,
  }, async ({ portal }) => textResult(listEndpoints(portal)));

  server.registerTool("jpdcl_guide", {
    title: "JPDCL AI operation guide",
    description: "Return the embedded source-selection, provenance, freshness, tariff, privacy, and safety rules.",
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_LOCAL,
  }, async () => textResult(MCP_GUIDE));

  server.registerTool("jpdcl_energy_ledger", {
    title: "Get daily import and export ledger",
    description: "Get read-only cumulative import, export, and net-import registers with deterministic daily and period differences for the linked JPDCL account.",
    inputSchema: {
      accountId: z.string().optional(),
      from: isoDateSchema.optional().describe("YYYY-MM-DD; defaults to the first day of the latest month"),
      to: isoDateSchema.optional().describe("YYYY-MM-DD; defaults to the latest observation"),
      limit: z.number().int().nonnegative().max(100).default(35),
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_EXTERNAL,
  }, async ({ accountId, from, to, limit }) => run(() => {
    assertDateRange(from, to);
    return runtime.energyLedger(accountId, { from, to, limit });
  }));

  if (options.includeSmartTools) {
    server.registerTool("jpdcl_snapshot", {
      title: "Get combined JPDCL account snapshot",
      description: "Get a normalized, provenance-labelled snapshot combining billing records, Genus smart-meter data, the daily import/export ledger, and a clearly labelled tariff estimate.",
      inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId }) => run(() => runtime.aiSnapshot(accountId)));

    server.registerTool("jpdcl_meter_health", {
      title: "Get meter and supply health",
      description: "Combine connection state, recent meter values, voltage freshness, outage events, daily-ledger freshness, and alarms for the linked account.",
      inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId }) => run(() => runtime.meterHealth(accountId)));

    server.registerTool("jpdcl_smart_session", {
      title: "Get smart-meter session and linked accounts",
      description: "Get the linked Genus account, meter, plan, metering mode, tenant, token expiry, and smart-account metadata. This is account context, not live electrical state.",
      inputSchema: {},
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async () => run(async () => (await runtime.ensureSmart()).connections()));

    server.registerTool("jpdcl_smart_dashboard", {
      title: "Get smart-meter data dashboard",
      description: "Get measured readings and account records. Predictions, recommendations, estimates, and smart tips are excluded unless includeDerived is explicitly enabled.",
      inputSchema: {
        accountId: z.string().optional().describe("Defaults to the linked account"),
        includeDerived: z.boolean().default(false).describe("Opt in to clearly labelled forecasts and advice that are not meter evidence"),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId, includeDerived }) => run(async () =>
      (await runtime.ensureSmart(accountId)).dashboard(accountId, { includeDerived })));

    server.registerTool("jpdcl_smart_consumption", {
      title: "Get current smart-meter consumption",
      description: "Get the same utility-reported today and current-month consumption feed used by the Genus portal, together with a requested daily, weekly, or monthly comparison. This does not use on-demand readings or forecasts.",
      inputSchema: {
        accountId: z.string().optional().describe("Defaults to the linked account"),
        type: z.enum(["daily", "weekly", "monthly"]).default("monthly"),
        value: z.number().int().positive().max(366).default(12),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId, type, value }) => run(() => runtime.smartConsumption(accountId, type, value)));

    server.registerTool("jpdcl_smart_intervals", {
      title: "Get half-hour smart-meter readings",
      description: "Get utility-recorded half-hour import and export readings over an ISO date range.",
      inputSchema: {
        accountId: z.string().optional().describe("Defaults to the linked account"),
        from: isoDateSchema.describe("YYYY-MM-DD"),
        to: isoDateSchema.describe("YYYY-MM-DD"),
        sortOrder: z.string().default("date"),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId, from, to, sortOrder }) => run(async () => {
      assertDateRange(from, to, { requireBoth: true });
      return (await runtime.ensureSmart(accountId)).intervalConsumption(accountId, from, to, sortOrder);
    }));

    server.registerTool("jpdcl_smart_meter_profile", {
      title: "Get smart-meter technical profile",
      description: "Get meter and connection details including phase, metering mode, manufacturer, voltage, sanctioned load, installation date, address, tariff, and current reading.",
      inputSchema: {
        accountId: z.string().optional().describe("Defaults to the linked account"),
        meterNumber: z.string().optional().describe("Defaults to the linked meter"),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
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
      title: "Get smart-meter forecasts and advice",
      description: "Explicitly fetch clearly labelled predictions, comparisons, savings suggestions, and smart tips. These are derived outputs, not meter evidence.",
      inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
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
          warning: "Predictions, comparisons, savings suggestions, and smart tips are not meter evidence.",
        },
        today: today.data,
        weekly: weekly.data,
        monthly: monthly.data,
        insights: insights.data,
      };
    }));

    server.registerTool("jpdcl_smart_alerts", {
      title: "Get smart-meter usage alerts",
      description: "Get live consumption and configured daily and monthly alert thresholds and descriptions.",
      inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId }) => run(async () => {
      const client = await runtime.ensureSmart(accountId);
      if (!client.accountId || !client.meterNumber) throw new JpdclError("Smart account is incomplete", 400);
      return client.request("smart_my_alerts", { params: { accountId: client.accountId, meterNumber: client.meterNumber } });
    }));

    server.registerTool("jpdcl_smart_preferences", {
      title: "Get smart-meter notification preferences",
      description: "Get every notification category and channel setting shown on the linked account.",
      inputSchema: {
        accountId: z.string().optional().describe("Defaults to the linked account"),
        isPrepaid: z.boolean().optional().describe("Defaults to the linked account plan"),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId, isPrepaid }) => run(async () => {
      const client = await runtime.ensureSmart(accountId);
      const plan = isPrepaid ?? String(client.claims.currentAccountIsMeterPrepaid).toLowerCase() === "true";
      return client.request("smart_preferences", { params: { isPrepaid: plan } });
    }));

    server.registerTool("jpdcl_smart_support", {
      title: "Get JPDCL smart-meter support information",
      description: "Get FAQs, contact details, complaint categories, and the linked user's complaint list.",
      inputSchema: {
        accountId: z.string().optional().describe("Defaults to the linked account"),
        pageNumber: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(100).default(20),
        statusCodes: z.string().optional(),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
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
      title: "Get smart-meter notifications",
      description: "Get smart-portal notifications and unread count for the linked user.",
      inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
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

    server.registerTool("jpdcl_smart_report", {
      title: "Get complete smart-meter report",
      description: "Get the complete Genus report payload for power events, time-of-day use, peak slots, voltage, or sanctioned load versus demand. Date filters are passed to the portal and event arrays are not reduced to the latest row.",
      inputSchema: {
        accountId: z.string().optional().describe("Defaults to the linked account"),
        report: z.enum(["monthly_tod", "daily_tod", "power_events", "peak_slots", "peak_monthly", "voltage", "demand"]),
        from: isoDateSchema.optional().describe("YYYY-MM-DD; supply both from and to, or neither"),
        to: isoDateSchema.optional().describe("YYYY-MM-DD; supply both from and to, or neither"),
        start: z.number().int().positive().default(1),
        end: z.number().int().positive().optional(),
        filter: z.string().optional().describe("Advanced: pre-encoded portal report filter"),
        format: z.enum(["xlsx", "pdf"]).optional(),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId, report, from, to, start, end, filter, format }) => run(() => {
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
      title: "Read any catalogued JPDCL endpoint",
      description: "Call any non-mutating endpoint from jpdcl_catalog. Derived or advisory endpoints require an explicit allowDerived opt-in.",
      inputSchema: {
        endpoint: z.string().describe("Catalog endpoint name"),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        allowDerived: z.boolean().default(false).describe("Required for endpoints classified as derived or advisory"),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ endpoint, params, body, allowDerived }) => run(async () => {
      if (!isEndpointName(endpoint)) throw new JpdclError(`Unknown endpoint: ${endpoint}`, 400);
      const definition = endpointCatalog[endpoint];
      if (definition.mutation) throw new JpdclError("This hosted MCP is read-only", 400);
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
  }

  server.registerTool("jpdcl_tariff_estimate", {
    title: "Estimate current JPDCL charges",
    description: "Calculate a clearly labelled provisional domestic tariff estimate from the linked account's observed usage, category, sanctioned load, and plan. This never returns an issued bill.",
    inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_EXTERNAL,
  }, async ({ accountId }) => run(() => runtime.tariffEstimate(accountId, {}, { allowSmartFallback: false })));

  server.registerTool("jpdcl_tariff_schedule", {
    title: "Get encoded JPDCL tariff schedule",
    description: "Get the read-only encoded domestic tariff slabs, fixed charge, rebates, late-payment rate, official source URL, and cited source pages used by the estimator.",
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_LOCAL,
  }, async () => textResult(JPDCL_TARIFF_ORDER_2025_26));

  server.registerTool("jpdcl_account_info", {
    title: "Get JPDCL account information",
    description: "Get read-only consumer profile, issued current bill, outstanding amount, meter, tariff, load, subdivision, and account-type records.",
    inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_EXTERNAL,
  }, async ({ accountId }) => run(async () => {
    await runtime.ensureLogin();
    return runtime.main.customerInfo(accountId);
  }));

  server.registerTool("jpdcl_account_digest", {
    title: "Get JPDCL billing digest",
    description: "Get a read-only digest of profile, current bill, meter, issued billing history, payment history, consumption, and linked accounts.",
    inputSchema: { accountId: z.string().optional().describe("Defaults to the linked account") },
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_EXTERNAL,
  }, async ({ accountId }) => run(async () => {
    await runtime.ensureLogin();
    return runtime.main.digest(accountId);
  }));

  for (const [toolName, type, title] of [
    ["jpdcl_bills", "BILL", "Get JPDCL issued bills"],
    ["jpdcl_payments", "PAYM", "Get JPDCL payment history"],
  ] as const) {
    server.registerTool(toolName, {
      title,
      description: `Get read-only ${type === "BILL" ? "utility-issued bill assessments" : "payments and receipts"} for the linked account over a date range of up to six months.`,
      inputSchema: {
        accountId: z.string().optional(),
        from: isoDateSchema.optional().describe("YYYY-MM-DD"),
        to: isoDateSchema.optional().describe("YYYY-MM-DD"),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId, from, to }) => run(async () => {
      assertDateRange(from, to);
      await runtime.ensureLogin();
      return runtime.main.history(type, accountId, from, to);
    }));
  }

  server.registerTool("jpdcl_consumption", {
    title: "Get JPDCL consumption history",
    description: "Get read-only billed import/export register readings and electricity consumption for the linked account over a date range of up to six months.",
    inputSchema: {
      accountId: z.string().optional(),
      from: isoDateSchema.optional().describe("YYYY-MM-DD"),
      to: isoDateSchema.optional().describe("YYYY-MM-DD"),
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: READ_EXTERNAL,
  }, async ({ accountId, from, to }) => run(async () => {
    assertDateRange(from, to);
    await runtime.ensureLogin();
    return runtime.main.consumption(accountId, from, to);
  }));

  return server;
}
