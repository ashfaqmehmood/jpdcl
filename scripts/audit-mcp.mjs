import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const isoDaysAgo = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

const today = isoDaysAgo(0);
const recent = isoDaysAgo(7);
const historyStart = isoDaysAgo(150);
const cases = {
  jpdcl_catalog: {},
  jpdcl_guide: {},
  jpdcl_session_status: {},
  jpdcl_snapshot: {},
  jpdcl_tariff_estimate: {},
  jpdcl_tariff_schedule: {},
  jpdcl_energy_ledger: { limit: 2 },
  jpdcl_meter_health: {},
  jpdcl_account_info: {},
  jpdcl_account_digest: {},
  jpdcl_bills: { from: historyStart, to: today },
  jpdcl_payments: { from: historyStart, to: today },
  jpdcl_consumption: { from: historyStart, to: today },
  jpdcl_smart_session: {},
  jpdcl_smart_dashboard: {},
  jpdcl_smart_consumption: { type: "monthly", value: 2 },
  jpdcl_smart_intervals: { from: recent, to: today },
  jpdcl_smart_meter_profile: {},
  jpdcl_smart_forecasts: {},
  jpdcl_smart_billing: {},
  jpdcl_smart_alerts: {},
  jpdcl_smart_preferences: {},
  jpdcl_smart_support: { pageSize: 5 },
  jpdcl_smart_notifications: {},
  jpdcl_smart_nearby_offices: { latitude: 32.7266, longitude: 74.8570 },
  jpdcl_smart_report: { report: "voltage", from: recent, to: today, end: 5 },
  jpdcl_read: { endpoint: "main_complaint_types" },
};

const auditCommand = process.env.JPDCL_MCP_AUDIT_COMMAND || process.execPath;
const auditArgs = process.env.JPDCL_MCP_AUDIT_ARGS
  ? JSON.parse(process.env.JPDCL_MCP_AUDIT_ARGS)
  : [new URL("../dist/mcp-stdio.js", import.meta.url).pathname];

const transport = new StdioClientTransport({
  command: auditCommand,
  args: auditArgs,
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
  stderr: "pipe",
});
const client = new Client({ name: "jpdcl-mcp-audit", version: "1.0.0" });

try {
  await client.connect(transport);
  if (client.getServerVersion()?.name !== "JPDCL Smart Meter") {
    throw new Error(`Unexpected MCP server name: ${client.getServerVersion()?.name ?? "missing"}`);
  }
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const missingMetadata = listed.tools
    .filter((tool) => !tool.title || !tool.description || !tool.annotations)
    .map((tool) => tool.name);
  const untested = names.filter((name) => name !== "jpdcl_auth_login" && !(name in cases) && name !== "jpdcl_mutate");
  const unknownCases = Object.keys(cases).filter((name) => !names.includes(name));
  if (duplicates.length || missingMetadata.length || untested.length || unknownCases.length) {
    throw new Error(JSON.stringify({ duplicates, missingMetadata, untested, unknownCases }));
  }

  const authTool = listed.tools.find((tool) => tool.name === "jpdcl_auth_login");
  const authRequired = authTool?.inputSchema?.required ?? [];
  if (!authRequired.includes("loginId") || !authRequired.includes("password")) {
    throw new Error("jpdcl_auth_login must require loginId and password");
  }
  let authenticationCheck = "schema-only (no configured credentials)";
  const { resolveCredentials } = await import("../dist/credentials.js");
  const credentials = await resolveCredentials();
  if (credentials) {
    const authentication = await client.callTool({
      name: "jpdcl_auth_login",
      arguments: { loginId: credentials.loginId, password: credentials.password, saveToEnv: false },
    });
    if (authentication.isError || !authentication.structuredContent?.authenticated) {
      throw new Error("jpdcl_auth_login failed with the configured credentials");
    }
    authenticationCheck = "live login passed without rewriting credentials";
  }

  const results = [];
  const upstreamUnavailable = [];
  for (const [name, args] of Object.entries(cases)) {
    const started = Date.now();
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
    results.push({ name, ok: !response.isError, milliseconds: Date.now() - started });
    if (response.isError) throw new Error(`${name} failed its live read-only audit`);
    if (!response.structuredContent) throw new Error(`${name} returned no structuredContent`);
    if (response.structuredContent?._meta?.available === false) upstreamUnavailable.push(name);
  }

  const mutationGuard = await client.callTool({
    name: "jpdcl_mutate",
    arguments: { endpoint: "main_update_contact", confirm: false },
  });
  if (!mutationGuard.isError || !mutationGuard.content?.some((block) => block.type === "text" && block.text.includes("confirm=true"))) {
    throw new Error("jpdcl_mutate explicit-confirmation guard failed");
  }

  const derivedGuard = await client.callTool({
    name: "jpdcl_read",
    arguments: { endpoint: "smart_forecast_today" },
  });
  if (!derivedGuard.isError || !derivedGuard.content?.some((block) => block.type === "text" && block.text.includes("allowDerived=true"))) {
    throw new Error("jpdcl_read derived-data guard failed");
  }

  const resources = await client.listResources();
  for (const uri of ["jpdcl://catalog", "jpdcl://guide"]) {
    if (!resources.resources.some((resource) => resource.uri === uri)) throw new Error(`Missing MCP resource ${uri}`);
    const resource = await client.readResource({ uri });
    if (!resource.contents.length) throw new Error(`Empty MCP resource ${uri}`);
  }
  if (!client.getInstructions()?.includes("jpdcl_snapshot")) throw new Error("MCP initialization instructions are missing");

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    toolCount: names.length,
    liveReadToolsPassed: results.length,
    authenticationCheck,
    guardedToolsPassed: ["jpdcl_mutate confirmation", "jpdcl_read derived-data opt-in"],
    resourcesPassed: ["jpdcl://catalog", "jpdcl://guide"],
    upstreamUnavailable,
    slowest: [...results].sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 5),
  }, null, 2)}\n`);
} finally {
  await client.close();
}
