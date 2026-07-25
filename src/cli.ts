#!/usr/bin/env node
import { input, password as passwordPrompt } from "@inquirer/prompts";
import { Command } from "commander";
import fs from "node:fs/promises";
import { endpointCatalog, isEndpointName, listEndpoints } from "./catalog.js";
import { assertDateRange } from "./dates.js";
import { credentialStatus, deleteEnvCredentials, storeEnvCredentials } from "./credentials.js";
import { JpdclError } from "./errors.js";
import { clearSession } from "./session.js";
import { JPDCL_TARIFF_ORDER_2025_26, type DomesticTariffInput } from "./tariff.js";
import { JpdclRuntime } from "./runtime.js";

const program = new Command();
program
  .name("jpdcl")
  .description("API-only CLI for Jammu Power Distribution Corporation Limited (JPDCL) consumer and smart-meter services")
  .version("1.0.0")
  .option("--compact", "print compact JSON");

const print = (value: unknown) => {
  const compact = program.opts<{ compact?: boolean }>().compact;
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
};

const auth = program.command("auth").description("Manage API authentication");
auth
  .command("login")
  .description("Log in and save a session; optionally save credentials to the private project .env")
  .option("--login-id <id>", "mobile number or email")
  .option("--save-env", "store credentials in .env for automatic MCP/CLI re-login")
  .action(async (options: { loginId?: string; saveEnv?: boolean }) => {
    const loginId = options.loginId || process.env.JPDCL_LOGIN_ID || await input({ message: "JPDCL mobile/email:" });
    const secret = process.env.JPDCL_PASSWORD || await passwordPrompt({ message: "JPDCL password:", mask: "*" });
    const runtime = await JpdclRuntime.create();
    const result = await runtime.login(loginId, secret);
    const envFile = options.saveEnv ? await storeEnvCredentials(loginId, secret) : undefined;
    print({
      status: result.status,
      message: result.message ?? "Login successful",
      sessionSaved: true,
      automaticRelogin: Boolean(options.saveEnv || (process.env.JPDCL_LOGIN_ID && process.env.JPDCL_PASSWORD)),
      credentialStorage: options.saveEnv ? "private .env" : "not stored",
      envFile,
    });
  });
auth.command("status").action(async () => {
  const runtime = await JpdclRuntime.create();
  const session = runtime.main.currentSession;
  const automatic = await credentialStatus();
  print(session ? {
    authenticated: true,
    loginId: session.loginId,
    primaryAccountId: session.primaryAccountId,
    smartAuthenticated: Boolean(session.smart?.token),
    smartExpiresAt: session.smart?.expiresAt,
    automaticRelogin: automatic.automaticRelogin,
    credentialSource: automatic.source,
    credentialFile: automatic.envFile,
    updatedAt: session.updatedAt,
  } : { authenticated: false });
});
auth.command("logout").option("--forget", "also remove JPDCL credentials from .env").action(async (options: { forget?: boolean }) => {
  const runtime = await JpdclRuntime.create();
  const credentialsRemoved = options.forget ? await deleteEnvCredentials() : false;
  await clearSession();
  print({ authenticated: false, sessionRemoved: true, credentialsRemoved, automaticReloginMayRemain: !options.forget });
});
auth.command("forget-credentials").description("Remove JPDCL credentials from the private project .env")
  .action(async () => {
    print({ removed: await deleteEnvCredentials(), sessionKept: true });
  });

program
  .command("catalog")
  .description("List every mapped JPDCL and smart-meter endpoint")
  .option("--portal <portal>", "main, smart, or ledger")
  .action((options: { portal?: string }) => {
    if (options.portal && !["main", "smart", "ledger"].includes(options.portal)) {
      throw new JpdclError("--portal must be main, smart, or ledger", 400);
    }
    print(listEndpoints(options.portal as "main" | "smart" | "ledger" | undefined));
  });

const account = program.command("account").description("Consumer account information");
account.command("info").option("--account <id>").action(async ({ account }: { account?: string }) => {
  const runtime = await readyRuntime();
  print(await runtime.main.customerInfo(account));
  await runtime.persist();
});
account.command("digest").option("--account <id>").action(async ({ account }: { account?: string }) => {
  const runtime = await readyRuntime();
  print(await runtime.main.digest(account));
  await runtime.persist();
});
account.command("linked").action(async () => {
  const runtime = await readyRuntime();
  print(await runtime.main.linkedAccounts());
});

program.command("snapshot").description("Best AI-ready factual snapshot across JPDCL and smart-meter APIs")
  .option("--account <id>")
  .action(async (o: { account?: string }) => {
    const runtime = await readyRuntime();
    print(await runtime.aiSnapshot(o.account));
  });

const tariff = program.command("tariff").description("Official JPDCL tariff rates and deterministic charge estimates");
tariff.command("rates").description("Show the encoded FY 2025-26 domestic tariff and source pages")
  .action(() => print(JPDCL_TARIFF_ORDER_2025_26));
tariff.command("estimate").description("Calculate domestic charges; current smart-meter month and account load are automatic by default")
  .option("--account <id>")
  .option("--units <kwh>", "override automatically selected current-period meter consumption")
  .option("--load <kw>", "override portal sanctioned load")
  .option("--prepaid", "apply the official 2% prepaid energy rebate")
  .option("--solar-water-heater", "apply the Rs.150 verified solar-water-heater rebate")
  .option("--electricity-duty <amount>", "explicit duty amount; never guessed")
  .option("--other-charges <amount>", "explicit adjustments or other charges")
  .option("--unpaid-principal <amount>", "principal subject to late-payment surcharge")
  .option("--late-months <months>", "months late at 1.5% per month")
  .action(async (o: {
    account?: string; units?: string; load?: string; prepaid?: boolean; solarWaterHeater?: boolean;
    electricityDuty?: string; otherCharges?: string; unpaidPrincipal?: string; lateMonths?: string;
  }) => {
    const runtime = await readyRuntime();
    const overrides: Partial<DomesticTariffInput> = {};
    if (o.units !== undefined) overrides.unitsKwh = cliNumber("units", o.units);
    if (o.load !== undefined) overrides.sanctionedLoadKw = cliNumber("load", o.load);
    if (o.prepaid) overrides.prepaid = true;
    if (o.solarWaterHeater) overrides.solarWaterHeaterEligible = true;
    if (o.electricityDuty !== undefined) overrides.electricityDutyAmount = cliNumber("electricity-duty", o.electricityDuty);
    if (o.otherCharges !== undefined) overrides.otherChargesAmount = cliNumber("other-charges", o.otherCharges);
    if (o.unpaidPrincipal !== undefined) overrides.unpaidPrincipalAmount = cliNumber("unpaid-principal", o.unpaidPrincipal);
    if (o.lateMonths !== undefined) overrides.lateMonths = cliNumber("late-months", o.lateMonths);
    print(await runtime.tariffEstimate(o.account, overrides));
  });

program.command("bills")
  .option("--account <id>")
  .option("--from <yyyy-mm-dd>")
  .option("--to <yyyy-mm-dd>")
  .action(async (o: DateRangeOptions) => {
    assertDateRange(o.from, o.to);
    const runtime = await readyRuntime();
    print(await runtime.main.history("BILL", o.account, o.from, o.to));
  });
program.command("payments")
  .option("--account <id>")
  .option("--from <yyyy-mm-dd>")
  .option("--to <yyyy-mm-dd>")
  .action(async (o: DateRangeOptions) => {
    assertDateRange(o.from, o.to);
    const runtime = await readyRuntime();
    print(await runtime.main.history("PAYM", o.account, o.from, o.to));
  });
program.command("consumption")
  .option("--account <id>")
  .option("--from <yyyy-mm-dd>")
  .option("--to <yyyy-mm-dd>")
  .action(async (o: DateRangeOptions) => {
    assertDateRange(o.from, o.to);
    const runtime = await readyRuntime();
    print(await runtime.main.consumption(o.account, o.from, o.to));
  });

const smart = program.command("smart").description("Genus smart-meter records, readings, reports, and status evidence");
smart.command("connect")
  .option("--account <id>")
  .option("--meter <number>")
  .action(async (o: { account?: string; meter?: string }) => {
    const runtime = await readyRuntime();
    const client = await runtime.ensureSmart(o.account, o.meter);
    print({ connected: Boolean(client.bearerToken), tokenSaved: true });
  });
smart.command("session").description("Show smart-meter SSO account/session metadata").action(async () => {
  const runtime = await readyRuntime();
  print(await (await runtime.ensureSmart()).connections());
});
smart.command("dashboard").description("Measured/account smart-meter digest; predictions and tips are excluded by default")
  .option("--account <id>")
  .option("--include-derived", "include forecasts, estimates, insights, and smart tips")
  .action(async (o: { account?: string; includeDerived?: boolean }) => {
  const runtime = await readyRuntime();
  print(await (await runtime.ensureSmart(o.account)).dashboard(o.account, { includeDerived: o.includeDerived }));
});
smart.command("meter").description("Meter technical profile and current reading")
  .option("--account <id>").option("--meter <number>")
  .action(async (o: { account?: string; meter?: string }) => {
    const runtime = await readyRuntime();
    const client = await runtime.ensureSmart(o.account, o.meter);
    const accountId = o.account ?? client.accountId;
    const meterNumber = o.meter ?? client.meterNumber;
    if (!accountId || !meterNumber) throw new JpdclError("Account ID and meter number are required", 400);
    const [details, reading] = await Promise.all([
      client.request("smart_meter_details", { params: { meterNumber } }),
      client.request("smart_current_meter_reading", { params: { accountId } }),
    ]);
    print({ details: details.data, currentReading: reading.data });
  });
smart.command("health").description("Unified supply, connectivity evidence, on-demand readings, voltage, outages, daily ledger, and alarms")
  .option("--account <id>").action(async (o: { account?: string }) => {
    const runtime = await readyRuntime();
    print(await runtime.meterHealth(o.account));
  });
smart.command("alerts").description("Live usage and daily/monthly alert thresholds")
  .option("--account <id>").action(async (o: { account?: string }) => {
    const runtime = await readyRuntime();
    const client = await runtime.ensureSmart(o.account);
    if (!client.accountId || !client.meterNumber) throw new JpdclError("Smart account is incomplete", 400);
    print(await client.request("smart_my_alerts", { params: { accountId: client.accountId, meterNumber: client.meterNumber } }));
  });
smart.command("billing").description("Postpaid bills/payments or prepaid balance/recharges, selected automatically")
  .option("--account <id>").action(async (o: { account?: string }) => {
    const runtime = await readyRuntime();
    const client = await runtime.ensureSmart(o.account);
    if (!client.accountId || !client.meterNumber) throw new JpdclError("Smart account is incomplete", 400);
    const isPrepaid = String(client.claims.currentAccountIsMeterPrepaid).toLowerCase() === "true";
    if (isPrepaid) {
      const [balance, rechargeBalance, recharges, bills] = await Promise.all([
        client.request("smart_prepaid_balance", { params: { meterNumber: client.meterNumber } }),
        client.request("smart_prepaid_recharge_balance", { params: { accountId: client.accountId } }),
        client.request("smart_prepaid_recharge_history", { params: { meterNumber: client.meterNumber } }),
        client.request("smart_prepaid_bill_history", { params: { meterNumber: client.meterNumber } }),
      ]);
      print({ plan: "prepaid", balance: balance.data, rechargeBalance: rechargeBalance.data, recharges: recharges.data, bills: bills.data });
      return;
    }
    const [lastBill, bills, payments] = await Promise.all([
      client.request("smart_postpaid_last_bill", { params: { accountId: client.accountId } }),
      client.request("smart_postpaid_bill_history", { params: { accountId: client.accountId } }),
      client.request("smart_postpaid_payment_history", { params: { accountId: client.accountId } }),
    ]);
    print({ plan: "postpaid", lastBill: lastBill.data, bills: bills.data, payments: payments.data });
  });
smart.command("preferences").description("Every notification category and delivery-channel preference")
  .option("--account <id>").action(async (o: { account?: string }) => {
    const runtime = await readyRuntime();
    const client = await runtime.ensureSmart(o.account);
    const isPrepaid = String(client.claims.currentAccountIsMeterPrepaid).toLowerCase() === "true";
    print(await client.request("smart_preferences", { params: { isPrepaid } }));
  });
smart.command("notifications").description("Notifications and unread count")
  .option("--account <id>").action(async (o: { account?: string }) => {
    const runtime = await readyRuntime();
    const client = await runtime.ensureSmart(o.account);
    const userId = typeof client.claims.sub === "string" ? client.claims.sub : undefined;
    if (!userId) throw new JpdclError("Smart user ID is unavailable", 400);
    const [items, unread] = await Promise.all([
      client.request("smart_notifications", { params: { userId } }).catch(() => ({ status: true, data: [] })),
      client.request("smart_notification_unread_count", { params: { userId } }).catch(() => ({ status: true, data: { unreadCount: 0 } })),
    ]);
    print({ items: items.data, unread: unread.data });
  });
smart.command("support").description("FAQs, contact details, categories, and complaint history")
  .option("--account <id>").option("--page <number>", "page number", "1").option("--page-size <number>", "records per page", "20")
  .action(async (o: { account?: string; page: string; pageSize: string }) => {
    const runtime = await readyRuntime();
    const client = await runtime.ensureSmart(o.account);
    const userId = typeof client.claims.sub === "string" ? client.claims.sub : undefined;
    if (!userId) throw new JpdclError("Smart user ID is unavailable", 400);
    const [faqs, contact, categories, complaints] = await Promise.all([
      client.request("smart_faqs"), client.request("smart_contact_support").catch(() => ({ status: true, data: null })), client.request("smart_complaint_categories"),
      client.request("smart_complaints", { params: { userId, pageNumber: Number(o.page), pageSize: Number(o.pageSize) } }),
    ]);
    print({ faqs: faqs.data, contact: contact.data, categories: categories.data, complaints: complaints.data });
  });
smart.command("consumption")
  .option("--account <id>")
  .option("--type <type>", "daily, weekly, or monthly", "monthly")
  .option("--value <number>", "number of periods", "12")
  .action(async (o: { account?: string; type: string; value: string }) => {
    const runtime = await readyRuntime();
    if (!["daily", "weekly", "monthly"].includes(o.type)) throw new JpdclError("--type must be daily, weekly, or monthly", 400);
    print(await runtime.smartConsumption(o.account, o.type as "daily" | "weekly" | "monthly", Number(o.value)));
  });
smart.command("intervals")
  .option("--account <id>")
  .requiredOption("--from <yyyy-mm-dd>")
  .requiredOption("--to <yyyy-mm-dd>")
  .option("--sort <order>", "date or another portal-supported order", "date")
  .action(async (o: { account?: string; from: string; to: string; sort: string }) => {
    assertDateRange(o.from, o.to, { requireBoth: true });
    const runtime = await readyRuntime();
    print(await (await runtime.ensureSmart(o.account)).intervalConsumption(o.account, o.from, o.to, o.sort));
  });
smart.command("report")
  .option("--account <id>")
  .requiredOption("--type <type>", "monthly-tod, daily-tod, power-events, peak-slots, peak-monthly, voltage, or demand")
  .option("--from <yyyy-mm-dd>")
  .option("--to <yyyy-mm-dd>")
  .option("--start <number>", "first record", "1")
  .option("--end <number>", "last record")
  .option("--filter <value>", "advanced: pre-encoded portal report filter")
  .option("--format <format>", "xlsx or pdf")
  .action(async (o: { account?: string; type: string; from?: string; to?: string; start: string; end?: string; filter?: string; format?: "xlsx" | "pdf" }) => {
    assertDateRange(o.from, o.to, { pairedWhenPresent: true });
    const names = {
      "monthly-tod": "MonthlyTOD",
      "daily-tod": "DayWiseTOD",
      "power-events": "PowerOnOff",
      "peak-slots": "PeakSlotConsumption",
      "peak-monthly": "PeakSlotConsumptionMonthly",
      voltage: "ConsumerVoltageDataProfile",
      demand: "SanctionLoadVSMaxDemand",
    } as const;
    const name = names[o.type as keyof typeof names];
    if (!name) throw new JpdclError("Unknown report type", 400);
    const runtime = await readyRuntime();
    print(await runtime.smartReport(o.account, name, {
      from: o.from,
      to: o.to,
      start: Number(o.start),
      end: o.end ? Number(o.end) : undefined,
      filter: o.filter,
      format: o.format,
    }));
  });

const ledger = program.command("ledger").description("Public JPDCL daily smart-meter import/export register ledger");
ledger.command("readings")
  .option("--account <id>")
  .option("--from <yyyy-mm-dd>")
  .option("--to <yyyy-mm-dd>")
  .option("--limit <count>", "maximum daily rows returned", "35")
  .action(async (o: { account?: string; from?: string; to?: string; limit: string }) => {
    assertDateRange(o.from, o.to);
    const runtime = await readyRuntime();
    print(await runtime.energyLedger(o.account, { from: o.from, to: o.to, limit: cliNumber("limit", o.limit) }));
  });
ledger.command("summary")
  .option("--account <id>")
  .option("--month <yyyy-mm>", "defaults to the latest available ledger month")
  .action(async (o: { account?: string; month?: string }) => {
    if (o.month && !/^\d{4}-\d{2}$/.test(o.month)) throw new JpdclError("--month must be YYYY-MM", 400);
    const runtime = await readyRuntime();
    const from = o.month ? `${o.month}-01` : undefined;
    const to = o.month ? `${o.month}-31` : undefined;
    const result = await runtime.energyLedger(o.account, { from, to, limit: 0 });
    print(result);
  });

program.command("request")
  .description("Call any catalog endpoint directly")
  .argument("<endpoint>")
  .option("--params <json>", "URL parameter JSON", "{}")
  .option("--body <json>", "request body/filter JSON", "{}")
  .option("--output <file>", "write base64 binary data to a file")
  .option("--confirm", "confirm this exact account-changing endpoint")
  .action(async (name: string, options: { params: string; body: string; output?: string; confirm?: boolean }) => {
    if (!isEndpointName(name)) throw new JpdclError(`Unknown endpoint: ${name}`, 400);
    const runtime = await readyRuntime();
    const request = { params: JSON.parse(options.params), body: JSON.parse(options.body) };
    const definition = endpointCatalog[name];
    if (definition.mutation && !options.confirm) {
      throw new JpdclError("Mutating endpoints require --confirm and JPDCL_ENABLE_MUTATIONS=true", 400);
    }
    const result = definition.portal === "main"
      ? await runtime.main.request(name, request)
      : definition.portal === "smart"
        ? await (await runtime.ensureSmart()).request(name, request)
        : await runtime.ledger.request(name, request);
    if (options.output) {
      const data = (result as { data?: { base64?: string } | string }).data;
      const base64 = typeof data === "string" ? data : data?.base64;
      if (!base64) throw new JpdclError("The response did not contain base64 file data", 422);
      await fs.writeFile(options.output, Buffer.from(base64, "base64"));
      print({ saved: options.output });
    } else print(result);
    await runtime.persist();
  });

interface DateRangeOptions {
  account?: string;
  from?: string;
  to?: string;
}

function cliNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new JpdclError(`--${name} must be a non-negative number`, 400);
  return parsed;
}

async function readyRuntime(): Promise<JpdclRuntime> {
  const runtime = await JpdclRuntime.create();
  await runtime.ensureLogin();
  return runtime;
}

program.parseAsync().catch((error: unknown) => {
  const known = error instanceof JpdclError;
  process.stderr.write(`${JSON.stringify({
    error: known ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    status: known ? error.status : 500,
    details: known ? error.details : undefined,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
