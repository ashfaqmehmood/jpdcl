import { input, password as passwordPrompt } from "@inquirer/prompts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function toolError(response: { content?: unknown }): UnknownRecord | undefined {
  const blocks = Array.isArray(response.content) ? response.content : [];
  for (const block of blocks) {
    const item = record(block);
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try { return record(JSON.parse(item.text)); } catch { /* Keep the audit output data-free. */ }
  }
  return undefined;
}

function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

const origin = (process.env.JPDCL_HOSTED_ORIGIN ?? "https://jpdcl.ashfaq.workers.dev").replace(/\/$/, "");
const transportOrigin = (process.env.JPDCL_HOSTED_TRANSPORT_ORIGIN ?? origin).replace(/\/$/, "");
const proxySecret = process.env.JPDCL_PROXY_SECRET?.trim();
const loginId = process.env.JPDCL_LOGIN_ID || await input({ message: "JPDCL mobile/email:" });
const password = process.env.JPDCL_PASSWORD || await passwordPrompt({ message: "JPDCL password:", mask: "*" });
const redirectUri = "https://localhost/jpdcl-oauth-audit";
let refreshToken: string | undefined;
let client: Client | undefined;

try {
  const registrationResponse = await fetch(`${transportOrigin}/oauth/register`, {
    method: "POST",
    headers: requestHeaders({ accept: "application/json", "content-type": "application/json" }),
    body: JSON.stringify({ client_name: "JPDCL hosted audit", redirect_uris: [redirectUri] }),
  });
  if (!registrationResponse.ok) throw new Error(`Dynamic registration failed (${registrationResponse.status})`);
  const registration = await registrationResponse.json() as { client_id?: string };
  if (!registration.client_id) throw new Error("Dynamic registration returned no client ID");

  const verifier = randomBase64Url(48);
  const authorizeUrl = new URL(`${transportOrigin}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "jpdcl:read",
    resource: `${origin}/mcp`,
    state: randomBase64Url(16),
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  const authorizationPage = await fetch(authorizeUrl, { headers: requestHeaders() });
  const transactionId = /name="transaction_id" value="([^"]+)"/.exec(await authorizationPage.text())?.[1];
  if (!authorizationPage.ok || !transactionId) throw new Error("OAuth authorization page did not create a transaction");

  const linked = await fetch(`${transportOrigin}/oauth/authorize`, {
    method: "POST",
    headers: requestHeaders({ accept: "text/html,application/json", "content-type": "application/x-www-form-urlencoded" }),
    redirect: "manual",
    body: new URLSearchParams({
      transaction_id: transactionId,
      login_id: loginId,
      password,
      consent: "approved",
    }),
  });
  const callback = linked.headers.get("location");
  if (linked.status !== 302 || !callback) throw new Error(`Hosted account linking failed (${linked.status})`);
  const code = new URL(callback).searchParams.get("code");
  if (!code) throw new Error("Hosted account linking returned no authorization code");

  const tokenResponse = await fetch(`${transportOrigin}/oauth/token`, {
    method: "POST",
    headers: requestHeaders({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      resource: `${origin}/mcp`,
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`OAuth token exchange failed (${tokenResponse.status})`);
  const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string };
  if (!tokens.access_token || !tokens.refresh_token) throw new Error("OAuth token exchange returned incomplete tokens");
  refreshToken = tokens.refresh_token;

  const transport = new StreamableHTTPClientTransport(new URL(`${transportOrigin}/mcp`), {
    requestInit: { headers: requestHeaders({ Authorization: `Bearer ${tokens.access_token}` }) },
  });
  client = new Client({ name: "jpdcl-hosted-oauth-audit", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  const expectedTools = new Map<string, UnknownRecord>([
    ["jpdcl_energy_ledger", { limit: 35 }],
    ["jpdcl_tariff_estimate", {}],
    ["jpdcl_tariff_schedule", {}],
    ["jpdcl_account_info", {}],
    ["jpdcl_account_digest", {}],
    ["jpdcl_bills", {}],
    ["jpdcl_payments", {}],
    ["jpdcl_consumption", {}],
  ]);
  if (process.env.JPDCL_HOSTED_SMART_TOOLS?.toLowerCase() === "true") {
    const today = new Date().toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    expectedTools.set("jpdcl_snapshot", {});
    expectedTools.set("jpdcl_meter_health", {});
    expectedTools.set("jpdcl_smart_consumption", { type: "monthly", value: 2 });
    expectedTools.set("jpdcl_smart_report", { report: "voltage", from: recent, to: today, end: 5 });
  }
  const discoveredNames = new Set(tools.tools.map((tool) => tool.name));
  const toolResponses = new Map<string, Awaited<ReturnType<Client["callTool"]>>>();
  for (const [name, arguments_] of expectedTools) {
    if (!discoveredNames.has(name)) continue;
    toolResponses.set(name, await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 45_000 }));
  }
  const toolResults = [...expectedTools.keys()].map((name) => {
    const response = toolResponses.get(name);
    const error = response ? toolError(response) : undefined;
    return {
      name,
      ok: response ? !response.isError : false,
      status: error?.status ?? null,
      error: error?.message ?? (response ? null : "not advertised"),
    };
  });
  const passed = tools.tools.length === expectedTools.size
    && tools.tools.every((tool) => expectedTools.has(tool.name))
    && toolResults.every((result) => result.ok);
  process.stdout.write(`${JSON.stringify({
    status: passed ? "ok" : "failed",
    oauth: "authorization-code-pkce",
    hostedService: true,
    toolCount: tools.tools.length,
    tools: toolResults,
    grantRevokedAfterAudit: true,
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  if (refreshToken) {
    await fetch(`${transportOrigin}/oauth/revoke`, {
      method: "POST",
      headers: requestHeaders({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ token: refreshToken }),
    }).catch(() => {});
  }
}

function requestHeaders(initial: HeadersInit = {}): Headers {
  const headers = new Headers(initial);
  if (proxySecret) headers.set("x-jpdcl-proxy-secret", proxySecret);
  return headers;
}
