import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertDateRange, isIsoDate } from "./dates.js";
import { JpdclError } from "./errors.js";
import { JpdclRuntime } from "./runtime.js";
import { JPDCL_TARIFF_ORDER_2025_26 } from "./tariff.js";

const PUBLIC_INSTRUCTIONS = `Read-only, independent JPDCL account access. Use jpdcl_account_digest for general account questions, jpdcl_smart_consumption for the Genus portal's current today/month values and comparisons, jpdcl_smart_report for complete dated analytical reports, jpdcl_energy_ledger for dated import/export registers, jpdcl_tariff_estimate for provisional charges, and billing tools for utility-issued bills and payments. Never describe an estimate as an issued bill or delayed readings as a live feed. Authentication happens only through OAuth account linking; never ask for or accept a JPDCL password in chat.`;
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
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_EXTERNAL,
    }, async ({ accountId, report, from, to, start, end }) => run(() => {
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
      return runtime.smartReport(accountId, names[report], { from, to, start, end });
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
