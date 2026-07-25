#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs/promises";
import { endpointCatalog, isEndpointName, listEndpoints } from "./catalog.js";
import { credentialStatus } from "./credentials.js";
import { JpdclError } from "./errors.js";
import { JpdclRuntime } from "./runtime.js";
import { JPDCL_TARIFF_ORDER_2025_26, type DomesticTariffInput } from "./tariff.js";

const app = new Hono();
const runtime = await JpdclRuntime.create();
const openApiDocument = await fs.readFile(new URL("../openapi.yaml", import.meta.url), "utf8");

app.use("/v1/*", async (c, next) => {
  const configuredKey = process.env.JPDCL_API_KEY;
  if (configuredKey && c.req.header("authorization") !== `Bearer ${configuredKey}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.onError((error, c) => {
  const known = error instanceof JpdclError;
  return c.json({
    error: known ? error.name : "InternalError",
    message: error.message,
    details: known ? error.details : undefined,
  }, (known && error.status && error.status >= 400 && error.status <= 599 ? error.status : 500) as 400);
});

app.get("/health", (c) => c.json({ status: "ok", service: "jpdcl-api", version: "1.0.0" }));
app.get("/", (c) => c.json({ service: "jpdcl-api", health: "/health", openapi: "/openapi.yaml", catalog: "/v1/catalog" }));
app.get("/openapi.yaml", (c) => c.text(openApiDocument, 200, { "Content-Type": "application/yaml; charset=utf-8" }));
app.get("/v1/catalog", (c) => c.json(listEndpoints(c.req.query("portal") as "main" | "smart" | "ledger" | undefined)));
app.get("/v1/tariff", (c) => c.json(JPDCL_TARIFF_ORDER_2025_26));

app.post("/v1/auth/login", async (c) => {
  const body = await c.req.json<{ loginId?: string; password?: string }>();
  if (!body.loginId || !body.password) throw new JpdclError("loginId and password are required", 400);
  const result = await runtime.login(body.loginId, body.password);
  return c.json({ status: result.status, message: result.message ?? "Login successful" });
});

app.get("/v1/me", async (c) => {
  await runtime.ensureLogin();
  const session = runtime.main.currentSession;
  const automatic = await credentialStatus();
  return c.json({
    loginId: session?.loginId,
    primaryAccountId: session?.primaryAccountId,
    smartAuthenticated: Boolean(session?.smart),
    smartExpiresAt: session?.smart?.expiresAt,
    automaticRelogin: automatic.automaticRelogin,
    credentialSource: automatic.source,
  });
});
app.get("/v1/snapshot", async (c) => c.json(await runtime.aiSnapshot(c.req.query("accountId"))));
app.get("/v1/accounts/:accountId", async (c) => {
  await runtime.ensureLogin();
  return c.json(await runtime.main.customerInfo(c.req.param("accountId")));
});
app.get("/v1/accounts/:accountId/digest", async (c) => {
  await runtime.ensureLogin();
  return c.json(await runtime.main.digest(c.req.param("accountId")));
});
app.get("/v1/accounts/:accountId/bills", async (c) => {
  await runtime.ensureLogin();
  return c.json(await runtime.main.history("BILL", c.req.param("accountId"), c.req.query("from"), c.req.query("to")));
});
app.get("/v1/accounts/:accountId/payments", async (c) => {
  await runtime.ensureLogin();
  return c.json(await runtime.main.history("PAYM", c.req.param("accountId"), c.req.query("from"), c.req.query("to")));
});
app.get("/v1/accounts/:accountId/consumption", async (c) => {
  await runtime.ensureLogin();
  return c.json(await runtime.main.consumption(c.req.param("accountId"), c.req.query("from"), c.req.query("to")));
});
app.get("/v1/accounts/:accountId/tariff-estimate", async (c) => {
  const query = c.req.query();
  const overrides: Partial<DomesticTariffInput> = {};
  assignQueryNumber(overrides, "unitsKwh", query.units);
  assignQueryNumber(overrides, "sanctionedLoadKw", query.load);
  assignQueryNumber(overrides, "electricityDutyAmount", query.electricityDuty);
  assignQueryNumber(overrides, "otherChargesAmount", query.otherCharges);
  assignQueryNumber(overrides, "unpaidPrincipalAmount", query.unpaidPrincipal);
  assignQueryNumber(overrides, "lateMonths", query.lateMonths);
  if (query.prepaid !== undefined) overrides.prepaid = query.prepaid === "true";
  if (query.solarWaterHeaterEligible !== undefined) overrides.solarWaterHeaterEligible = query.solarWaterHeaterEligible === "true";
  return c.json(await runtime.tariffEstimate(c.req.param("accountId"), overrides));
});
app.get("/v1/accounts/:accountId/energy-ledger", async (c) => {
  const limit = c.req.query("limit") === undefined ? 35 : Number(c.req.query("limit"));
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) throw new JpdclError("limit must be an integer from 0 to 500", 400);
  return c.json(await runtime.energyLedger(c.req.param("accountId"), {
    from: c.req.query("from"),
    to: c.req.query("to"),
    limit,
  }));
});
app.get("/v1/accounts/:accountId/meter-health", async (c) => {
  return c.json(await runtime.meterHealth(c.req.param("accountId")));
});
app.get("/v1/accounts/:accountId/meter-changes", async (c) => {
  await runtime.ensureLogin();
  return c.json(await runtime.main.request("main_meter_changes", { body: { accountid: c.req.param("accountId") } }));
});
app.get("/v1/linked-accounts", async (c) => {
  await runtime.ensureLogin();
  return c.json(await runtime.main.linkedAccounts());
});

app.get("/v1/smart/session", async (c) => c.json(await (await runtime.ensureSmart()).connections()));
app.get("/v1/smart/accounts/:accountId/dashboard", async (c) => {
  const accountId = c.req.param("accountId");
  return c.json(await (await runtime.ensureSmart(accountId)).dashboard(accountId, {
    includeDerived: c.req.query("includeDerived") === "true",
  }));
});
app.get("/v1/smart/accounts/:accountId/meter", async (c) => {
  const accountId = c.req.param("accountId");
  const client = await runtime.ensureSmart(accountId);
  if (!client.meterNumber) throw new JpdclError("Smart-meter number is unavailable", 400);
  const [details, reading] = await Promise.all([
    client.request("smart_meter_details", { params: { meterNumber: client.meterNumber } }),
    client.request("smart_current_meter_reading", { params: { accountId } }),
  ]);
  return c.json({ details: details.data, currentReading: reading.data });
});
app.get("/v1/smart/accounts/:accountId/alerts", async (c) => {
  const accountId = c.req.param("accountId");
  const client = await runtime.ensureSmart(accountId);
  if (!client.meterNumber) throw new JpdclError("Smart-meter number is unavailable", 400);
  return c.json(await client.request("smart_my_alerts", { params: { accountId, meterNumber: client.meterNumber } }));
});
app.get("/v1/smart/accounts/:accountId/preferences", async (c) => {
  const client = await runtime.ensureSmart(c.req.param("accountId"));
  const isPrepaid = String(client.claims.currentAccountIsMeterPrepaid).toLowerCase() === "true";
  return c.json(await client.request("smart_preferences", { params: { isPrepaid } }));
});
app.get("/v1/smart/accounts/:accountId/notifications", async (c) => {
  const client = await runtime.ensureSmart(c.req.param("accountId"));
  const userId = typeof client.claims.sub === "string" ? client.claims.sub : undefined;
  if (!userId) throw new JpdclError("Smart user ID is unavailable", 400);
  const [items, unread] = await Promise.all([
    client.request("smart_notifications", { params: { userId } }).catch(() => ({ status: true, data: [] })),
    client.request("smart_notification_unread_count", { params: { userId } }).catch(() => ({ status: true, data: { unreadCount: 0 } })),
  ]);
  return c.json({ items: items.data, unread: unread.data });
});
app.get("/v1/smart/accounts/:accountId/support", async (c) => {
  const client = await runtime.ensureSmart(c.req.param("accountId"));
  const userId = typeof client.claims.sub === "string" ? client.claims.sub : undefined;
  if (!userId) throw new JpdclError("Smart user ID is unavailable", 400);
  const [faqs, contact, categories, complaints] = await Promise.all([
    client.request("smart_faqs"), client.request("smart_contact_support").catch(() => ({ status: true, data: null })), client.request("smart_complaint_categories"),
    client.request("smart_complaints", { params: { userId, pageNumber: Number(c.req.query("page") ?? 1), pageSize: Number(c.req.query("pageSize") ?? 20), statusCodes: c.req.query("statusCodes") } }),
  ]);
  return c.json({ faqs: faqs.data, contact: contact.data, categories: categories.data, complaints: complaints.data });
});
app.get("/v1/smart/accounts/:accountId/consumption", async (c) => {
  const accountId = c.req.param("accountId");
  const type = c.req.query("type") ?? "monthly";
  if (!(["daily", "weekly", "monthly"] as const).includes(type as "daily" | "weekly" | "monthly")) {
    throw new JpdclError("type must be daily, weekly, or monthly", 400);
  }
  return c.json(await runtime.smartConsumption(accountId, type as "daily" | "weekly" | "monthly", Number(c.req.query("value") ?? 12)));
});
app.get("/v1/smart/accounts/:accountId/intervals", async (c) => {
  const accountId = c.req.param("accountId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) throw new JpdclError("from and to (YYYY-MM-DD) are required", 400);
  return c.json(await (await runtime.ensureSmart(accountId)).intervalConsumption(accountId, from, to, c.req.query("sort") ?? "date"));
});
app.get("/v1/smart/accounts/:accountId/reports/:reportType", async (c) => {
  const accountId = c.req.param("accountId");
  const reportType = c.req.param("reportType");
  const reportTypes = ["PowerOnOff", "DayWiseTOD", "MonthlyTOD", "PeakSlotConsumption", "PeakSlotConsumptionMonthly", "ConsumerVoltageDataProfile", "SanctionLoadVSMaxDemand"] as const;
  if (!reportTypes.includes(reportType as typeof reportTypes[number])) throw new JpdclError("Unknown smart report type", 400);
  return c.json(await runtime.smartReport(accountId, reportType as typeof reportTypes[number], {
    from: c.req.query("from"),
    to: c.req.query("to"),
    start: c.req.query("start") ? Number(c.req.query("start")) : undefined,
    end: c.req.query("end") ? Number(c.req.query("end")) : undefined,
    filter: c.req.query("filter"),
    format: c.req.query("format") as "xlsx" | "pdf" | undefined,
  }));
});

app.all("/v1/raw/:endpoint", async (c) => {
  const name = c.req.param("endpoint");
  if (!isEndpointName(name)) throw new JpdclError(`Unknown endpoint: ${name}`, 404);
  const requestUrl = new URL(c.req.url);
  const input = c.req.method === "GET"
    ? { params: Object.fromEntries(requestUrl.searchParams.entries()), confirm: requestUrl.searchParams.get("confirm") === "true" }
    : await c.req.json<{ params?: Record<string, string>; body?: unknown; confirm?: boolean }>();
  const definition = endpointCatalog[name];
  if (definition.mutation && !input.confirm) {
    throw new JpdclError("Mutating endpoints require confirm=true and JPDCL_ENABLE_MUTATIONS=true", 400);
  }
  if (input.params) delete input.params.confirm;
  const result = definition.portal === "main"
    ? await runtime.main.request(name, input)
    : definition.portal === "smart"
      ? await (await runtime.ensureSmart()).request(name, input)
      : await runtime.ledger.request(name, input);
  await runtime.persist();
  return c.json(result);
});

const port = Number(process.env.JPDCL_API_PORT ?? 8787);
const hostname = process.env.JPDCL_API_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  process.stderr.write(`JPDCL API listening on http://${hostname}:${info.port}\n`);
});

export { app };

function assignQueryNumber<T extends object, K extends keyof T>(target: T, key: K, raw: string | undefined): void {
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new JpdclError(`${String(key)} must be a non-negative number`, 400);
  target[key] = value as T[K];
}
