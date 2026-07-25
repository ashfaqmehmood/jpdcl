import type { Credentials } from "./credentials.js";
import type { OAuthStore } from "./oauth-store.js";

const OAUTH_SCOPE = "jpdcl:read";
const TRANSACTION_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const GRANT_TTL_MS = 30 * 24 * 60 * 60_000;

interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthorizationTransaction {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  expiresAt: number;
}

interface GrantRecord {
  grantId: string;
  clientId: string;
  encryptedCredentials: string;
  scope: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
}

interface AuthorizationCode {
  grantId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  expiresAt: number;
}

interface TokenRecord {
  grantId: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

export interface OAuthServiceOptions {
  encryptionKey: string;
  appsChallenge?: string;
  validateCredentials(credentials: Credentials): Promise<void>;
}

export async function handleOAuthRequest(
  request: Request,
  store: OAuthStore,
  options: OAuthServiceOptions,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const origin = url.origin;
  const resource = `${origin}/mcp`;

  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json({
      resource,
      authorization_servers: [origin],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/privacy`,
    });
  }

  if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [OAUTH_SCOPE],
    });
  }

  if (url.pathname === "/.well-known/openai-apps-challenge") {
    if (!options.appsChallenge?.trim()) return new Response("Not configured", { status: 404 });
    return new Response(options.appsChallenge.trim(), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (url.pathname === "/oauth/register") return registerClient(request, store);
  if (url.pathname === "/oauth/authorize") {
    return request.method === "GET"
      ? beginAuthorization(request, store, resource)
      : request.method === "POST"
        ? completeAuthorization(request, store, options)
        : oauthError("invalid_request", "Use GET or POST for authorization", 405);
  }
  if (url.pathname === "/oauth/token") return exchangeToken(request, store, options.encryptionKey, resource);
  if (url.pathname === "/oauth/revoke") return revokeToken(request, store);
  if (url.pathname === "/privacy") return htmlPage("Privacy policy", privacyPolicy(origin));
  if (url.pathname === "/terms") return htmlPage("Terms of use", termsOfUse(origin));
  if (url.pathname === "/support") return htmlPage("Support", supportPage());
  if (url.pathname === "/" || url.pathname === "/health") {
    if (url.pathname === "/health") return json({ status: "ok", service: "JPDCL Smart Meter OAuth MCP" });
    return htmlPage("JPDCL Smart Meter", landingPage(origin));
  }

  return undefined;
}

export async function authenticateMcpRequest(
  request: Request,
  store: OAuthStore,
  encryptionKey: string,
): Promise<Credentials | undefined> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match?.[1]) return undefined;
  const tokenKey = `access:${await hashOpaque(match[1])}`;
  const token = await store.get<TokenRecord>(tokenKey);
  const expectedResource = `${new URL(request.url).origin}/mcp`;
  if (!token || token.expiresAt <= Date.now() || token.resource !== expectedResource || !hasScope(token.scope, OAUTH_SCOPE)) {
    await store.delete(tokenKey);
    return undefined;
  }
  const grant = await store.get<GrantRecord>(`grant:${token.grantId}`);
  if (!grant || grant.expiresAt <= Date.now() || grant.clientId !== token.clientId) {
    await store.revokeGrant(token.grantId);
    return undefined;
  }
  const value = await decryptCredentials(grant.encryptedCredentials, encryptionKey, grant.grantId);
  return { ...value, source: "oauth" };
}

export function unauthorizedMcpResponse(request: Request): Response {
  const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  return json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authorization required. Link your JPDCL account through OAuth." },
    id: null,
  }, 401, {
    "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${OAUTH_SCOPE}"`,
  });
}

async function registerClient(request: Request, store: OAuthStore): Promise<Response> {
  if (request.method !== "POST") return oauthError("invalid_request", "Use POST for dynamic registration", 405);
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Registration body must be JSON");
  }
  const rawRedirects = payload.redirect_uris;
  if (!Array.isArray(rawRedirects) || rawRedirects.length === 0 || rawRedirects.length > 10) {
    return oauthError("invalid_redirect_uri", "Provide between one and ten redirect URIs");
  }
  const redirectUris = rawRedirects.filter((value): value is string => typeof value === "string");
  if (redirectUris.length !== rawRedirects.length || redirectUris.some((value) => !validRedirectUri(value))) {
    return oauthError("invalid_redirect_uri", "Redirect URIs must use HTTPS (localhost may use HTTP)");
  }
  const clientId = randomValue(24);
  const clientName = cleanText(payload.client_name, "OpenAI MCP client", 100);
  const client: OAuthClient = { clientId, clientName, redirectUris, createdAt: Date.now() };
  await store.put(`client:${clientId}`, client);
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201);
}

async function beginAuthorization(request: Request, store: OAuthStore, expectedResource: string): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const client = await store.get<OAuthClient>(`client:${clientId}`);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const requestedResource = url.searchParams.get("resource") ?? "";
  const scope = normalizeScope(url.searchParams.get("scope") ?? OAUTH_SCOPE);
  if (!client) return oauthError("unauthorized_client", "Unknown OAuth client");
  if (url.searchParams.get("response_type") !== "code") return oauthError("unsupported_response_type", "Only authorization code is supported");
  if (!client.redirectUris.includes(redirectUri)) return oauthError("invalid_request", "Redirect URI is not registered");
  if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return oauthError("invalid_request", "PKCE with S256 is required");
  }
  if (requestedResource !== expectedResource) return oauthError("invalid_target", "The resource parameter must identify this MCP server");
  if (!scope || !hasOnlySupportedScopes(scope)) return oauthError("invalid_scope", `Only ${OAUTH_SCOPE} is supported`);

  const transactionId = randomValue(24);
  const transaction: AuthorizationTransaction = {
    clientId,
    clientName: client.clientName,
    redirectUri,
    state: url.searchParams.get("state") ?? undefined,
    scope,
    resource: requestedResource,
    codeChallenge,
    expiresAt: Date.now() + TRANSACTION_TTL_MS,
  };
  await store.put(`txn:${transactionId}`, transaction);
  return authorizationForm(transactionId, transaction);
}

async function completeAuthorization(
  request: Request,
  store: OAuthStore,
  options: OAuthServiceOptions,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "Authorization form is invalid");
  }
  const transactionId = String(form.get("transaction_id") ?? "");
  const transaction = await store.get<AuthorizationTransaction>(`txn:${transactionId}`);
  if (!transaction || transaction.expiresAt <= Date.now()) return htmlPage("Link expired", "<p>This account-linking request expired. Return to ChatGPT or Codex and try again.</p>", 400);
  const loginId = String(form.get("login_id") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const consent = form.get("consent") === "approved";
  if (!loginId || !password || !consent) {
    return authorizationForm(transactionId, transaction, "Enter your JPDCL login, password, and approve read-only access.");
  }

  const credentials: Credentials = { loginId, password, source: "oauth" };
  try {
    await options.validateCredentials(credentials);
  } catch (error) {
    const message = error instanceof Error ? error.message : "JPDCL rejected the credentials";
    return authorizationForm(transactionId, transaction, message);
  }

  const consumed = await store.consume<AuthorizationTransaction>(`txn:${transactionId}`);
  if (!consumed) return htmlPage("Link expired", "<p>This account-linking request was already completed. Return to ChatGPT or Codex.</p>", 400);
  const now = Date.now();
  const grantId = randomValue(24);
  const grant: GrantRecord = {
    grantId,
    clientId: consumed.clientId,
    encryptedCredentials: await encryptCredentials({ loginId, password }, options.encryptionKey, grantId),
    scope: consumed.scope,
    resource: consumed.resource,
    createdAt: now,
    expiresAt: now + GRANT_TTL_MS,
  };
  const rawCode = randomValue(32);
  const code: AuthorizationCode = {
    grantId,
    clientId: consumed.clientId,
    redirectUri: consumed.redirectUri,
    scope: consumed.scope,
    resource: consumed.resource,
    codeChallenge: consumed.codeChallenge,
    expiresAt: now + CODE_TTL_MS,
  };
  await store.put(`grant:${grantId}`, grant);
  await store.put(`code:${await hashOpaque(rawCode)}`, code);

  const redirect = new URL(consumed.redirectUri);
  redirect.searchParams.set("code", rawCode);
  if (consumed.state) redirect.searchParams.set("state", consumed.state);
  return new Response(null, { status: 302, headers: { location: redirect.toString(), "cache-control": "no-store" } });
}

async function exchangeToken(
  request: Request,
  store: OAuthStore,
  encryptionKey: string,
  expectedResource: string,
): Promise<Response> {
  if (request.method !== "POST") return oauthError("invalid_request", "Use POST for token exchange", 405);
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return oauthError("invalid_request", "Token request is invalid");
  }
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";
  const requestedResource = form.get("resource") ?? "";
  if (!clientId || requestedResource !== expectedResource) return oauthError("invalid_request", "Valid client_id and resource are required");

  if (grantType === "authorization_code") {
    const rawCode = form.get("code") ?? "";
    const code = await store.consume<AuthorizationCode>(`code:${await hashOpaque(rawCode)}`);
    if (!code) return oauthError("invalid_grant", "Authorization code is invalid or expired");
    if (code.clientId !== clientId || code.redirectUri !== form.get("redirect_uri") || code.resource !== requestedResource) {
      await store.revokeGrant(code.grantId);
      return oauthError("invalid_grant", "Authorization code does not match this client");
    }
    if (!await verifyPkce(form.get("code_verifier") ?? "", code.codeChallenge)) {
      await store.revokeGrant(code.grantId);
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    return issueTokens(store, code.grantId, clientId, code.scope, code.resource);
  }

  if (grantType === "refresh_token") {
    const rawRefresh = form.get("refresh_token") ?? "";
    const refresh = await store.consume<TokenRecord>(`refresh:${await hashOpaque(rawRefresh)}`);
    if (!refresh || refresh.clientId !== clientId || refresh.resource !== requestedResource) {
      if (refresh) await store.revokeGrant(refresh.grantId);
      return oauthError("invalid_grant", "Refresh token is invalid or expired");
    }
    const grant = await store.get<GrantRecord>(`grant:${refresh.grantId}`);
    if (!grant) return oauthError("invalid_grant", "The account link has expired");
    await decryptCredentials(grant.encryptedCredentials, encryptionKey, grant.grantId);
    grant.expiresAt = Date.now() + GRANT_TTL_MS;
    await store.put(`grant:${grant.grantId}`, grant);
    return issueTokens(store, grant.grantId, clientId, refresh.scope, refresh.resource);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

async function issueTokens(
  store: OAuthStore,
  grantId: string,
  clientId: string,
  scope: string,
  resource: string,
): Promise<Response> {
  const rawAccess = randomValue(32);
  const rawRefresh = randomValue(32);
  const now = Date.now();
  await store.put<TokenRecord>(`access:${await hashOpaque(rawAccess)}`, {
    grantId,
    clientId,
    scope,
    resource,
    expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  await store.put<TokenRecord>(`refresh:${await hashOpaque(rawRefresh)}`, {
    grantId,
    clientId,
    scope,
    resource,
    expiresAt: now + GRANT_TTL_MS,
  });
  return json({
    access_token: rawAccess,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: rawRefresh,
    scope,
  }, 200, { "cache-control": "no-store", pragma: "no-cache" });
}

async function revokeToken(request: Request, store: OAuthStore): Promise<Response> {
  if (request.method !== "POST") return oauthError("invalid_request", "Use POST for token revocation", 405);
  const form = new URLSearchParams(await request.text());
  const rawToken = form.get("token") ?? "";
  if (rawToken) {
    const hash = await hashOpaque(rawToken);
    const token = await store.get<TokenRecord>(`refresh:${hash}`) ?? await store.get<TokenRecord>(`access:${hash}`);
    if (token) await store.revokeGrant(token.grantId);
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

function authorizationForm(transactionId: string, transaction: AuthorizationTransaction, error?: string): Response {
  const notice = error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : "";
  const body = `
    <header><span class="mark">⚡</span><div><h1>Link your JPDCL account</h1><p>Connect to ${escapeHtml(transaction.clientName)} with read-only access.</p></div></header>
    ${notice}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}">
      <label>JPDCL mobile number or email<input name="login_id" autocomplete="username" required></label>
      <label>JPDCL password<input name="password" type="password" autocomplete="current-password" required></label>
      <label class="consent"><input type="checkbox" name="consent" value="approved" required><span>Allow read-only access to my JPDCL account, bills, payments, consumption, and smart-meter records.</span></label>
      <button type="submit">Link account securely</button>
    </form>
    <p class="fine">Your password is sent over HTTPS directly to this independent connector, encrypted at rest, and never placed in an MCP tool call or shown to the AI. This project is not affiliated with JPDCL.</p>
    <nav><a href="/privacy" target="_blank" rel="noreferrer">Privacy</a><a href="/terms" target="_blank" rel="noreferrer">Terms</a><a href="/support" target="_blank" rel="noreferrer">Support</a></nav>`;
  return htmlPage("Link JPDCL account", body, error ? 401 : 200, {
    formActionOrigin: new URL(transaction.redirectUri).origin,
  });
}

function landingPage(origin: string): string {
  return `<header><span class="mark">⚡</span><div><h1>JPDCL Smart Meter</h1><p>Independent, read-only OAuth MCP connector.</p></div></header>
    <p>The MCP endpoint is <code>${escapeHtml(origin)}/mcp</code>. Compatible clients discover OAuth automatically and open the secure account-linking page.</p>
    <nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a><a href="https://github.com/ashfaqmehmood/jpdcl">Source</a></nav>`;
}

function privacyPolicy(origin: string): string {
  return `<h1>Privacy policy</h1><p>Effective July 24, 2026.</p>
    <h2>Independent service</h2><p>This open-source connector is not affiliated with or endorsed by JPDCL, JERC, Genus, or the Government of Jammu and Kashmir.</p>
    <h2>Data processed</h2><p>When you link an account, the service processes your JPDCL login ID and password, account identifiers, bills, payments, consumption, meter readings, and related utility records needed to answer your requests.</p>
    <h2>How credentials are handled</h2><p>Credentials are entered only on the HTTPS account-linking page. They are encrypted with AES-GCM before storage and are never included in MCP tool arguments or model-visible metadata. OAuth access and refresh tokens are random opaque values stored only as cryptographic hashes.</p>
    <h2>Use, sharing, and retention</h2><p>Data is used only to retrieve the JPDCL records you request. The hosted connector runs behind Cloudflare and Azure and sends credentials and account requests only to JPDCL-operated or JPDCL-linked systems. It does not sell personal data. Tool results are returned to the connected OpenAI product under that product's terms. The encrypted account link expires after 30 days without renewal and is deleted when OAuth access is revoked.</p>
    <h2>Security and deletion</h2><p>Transport uses HTTPS, write actions are not exposed by the public plugin, and application logs must not contain credentials or raw utility responses. To delete the stored account link, remove or disconnect the plugin in ChatGPT or Codex. You can also contact support.</p>
    <h2>Contact</h2><p>For privacy or security concerns, use the repository's <a href="https://github.com/ashfaqmehmood/jpdcl/security/advisories/new">private security-advisory form</a>. Use <a href="https://github.com/ashfaqmehmood/jpdcl/issues">public issues</a> only for non-sensitive support. Never include credentials, account IDs, bills, or meter readings.</p>
    <p><a href="${escapeHtml(origin)}/">Back</a></p>`;
}

function termsOfUse(origin: string): string {
  return `<h1>Terms of use</h1><p>Effective July 24, 2026.</p>
    <p>This is an independent, unofficial connector. You must use it only with a JPDCL account you are authorized to access and in compliance with applicable utility terms and law.</p>
    <p>The public plugin is read-only. Tariff calculations are estimates, not issued bills. Portal records can be delayed, incomplete, or unavailable, and the service is provided without warranties.</p>
    <p>Do not use the service to access another person's account, automate abuse, evade security controls, or submit secrets through prompts or support requests. You are responsible for reviewing sensitive results before sharing them.</p>
    <p>Access may be suspended to protect users, upstream services, or the connector. The MIT license governs the source code; these service terms govern the hosted connector.</p>
    <p><a href="${escapeHtml(origin)}/">Back</a></p>`;
}

function supportPage(): string {
  return `<h1>Support</h1><p>For connector problems, open an issue at <a href="https://github.com/ashfaqmehmood/jpdcl/issues">github.com/ashfaqmehmood/jpdcl/issues</a>.</p>
    <p>Never include your password, OAuth token, consumer number, account ID, complete bill, or meter readings in an issue.</p>
    <p>Report security or privacy concerns privately through <a href="https://github.com/ashfaqmehmood/jpdcl/security/advisories/new">GitHub Security Advisories</a>.</p>
    <p>For billing disputes, outages, account corrections, or official utility support, contact JPDCL through its official channels.</p>`;
}

function htmlPage(
  title: string,
  body: string,
  status = 200,
  options: { formActionOrigin?: string } = {},
): Response {
  const formAction = options.formActionOrigin
    ? `'self' ${cspOrigin(options.formActionOrigin)}`
    : "'self'";
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f4f1e8;color:#18201f}body{margin:0;padding:48px 20px}.card{max-width:620px;margin:auto;background:#fff;border:1px solid #d9d5ca;border-radius:24px;padding:32px;box-shadow:0 18px 50px #18201f18}header{display:flex;gap:16px;align-items:center;margin-bottom:26px}.mark{display:grid;place-items:center;width:54px;height:54px;border-radius:16px;background:#f6c84c;font-size:28px}h1{font-size:28px;margin:0 0 6px}h2{font-size:18px;margin-top:28px}p{line-height:1.55}header p,.fine{color:#56615f;margin:0}.fine{font-size:13px;margin-top:18px}label{display:grid;gap:8px;font-weight:650;margin:18px 0}input{font:inherit;padding:13px 14px;border:1px solid #b8bfbc;border-radius:12px;background:#fff;color:#18201f}.consent{grid-template-columns:20px 1fr;align-items:start;font-weight:450;line-height:1.4}.consent input{margin-top:3px}button{width:100%;border:0;border-radius:12px;padding:14px;background:#146c5c;color:#fff;font:inherit;font-weight:750;cursor:pointer}.error{border:1px solid #d77;background:#fff0f0;color:#8a1f1f;border-radius:12px;padding:12px 14px;margin:16px 0}nav{display:flex;gap:16px;flex-wrap:wrap;margin-top:22px}a{color:#126758}code{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){:root{background:#111817;color:#edf3f1}.card{background:#1b2422;border-color:#35413e}input{background:#111817;color:#edf3f1;border-color:#596763}header p,.fine{color:#abb8b4}.error{background:#3b2020;color:#ffc9c9;border-color:#8b4646}a{color:#7ed6c5}}
  </style></head><body><main class="card">${body}</main></body></html>`;
  return new Response(document, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function cspOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== value) {
    throw new Error("OAuth callback origin is not valid for CSP");
  }
  return url.origin;
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status, { "cache-control": "no-store", pragma: "no-cache" });
}

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders },
  });
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function normalizeScope(scope: string): string {
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort().join(" ");
}

function hasScope(scope: string, expected: string): boolean {
  return scope.split(/\s+/).includes(expected);
}

function hasOnlySupportedScopes(scope: string): boolean {
  const values = scope.split(/\s+/).filter(Boolean);
  return values.length > 0 && values.every((value) => value === OAUTH_SCOPE);
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function randomValue(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function verifyPkce(verifier: string, expected: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return await pkceChallenge(verifier) === expected;
}

async function hashOpaque(value: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function encryptCredentials(
  credentials: { loginId: string; password: string },
  encodedKey: string,
  grantId: string,
): Promise<string> {
  const key = await importEncryptionKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: new TextEncoder().encode(grantId),
  }, key, plaintext);
  return `v1.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptCredentials(
  value: string,
  encodedKey: string,
  grantId: string,
): Promise<{ loginId: string; password: string }> {
  const [version, rawIv, rawCiphertext] = value.split(".");
  if (version !== "v1" || !rawIv || !rawCiphertext) throw new Error("Stored OAuth credentials are unreadable");
  const key = await importEncryptionKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: toArrayBuffer(decodeBase64Url(rawIv)),
    additionalData: new TextEncoder().encode(grantId),
  }, key, toArrayBuffer(decodeBase64Url(rawCiphertext)));
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { loginId?: unknown; password?: unknown };
  if (typeof parsed.loginId !== "string" || typeof parsed.password !== "string") throw new Error("Stored OAuth credentials are invalid");
  return { loginId: parsed.loginId, password: parsed.password };
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = decodeBase64Url(encodedKey);
  } catch {
    throw new Error("OAUTH_ENCRYPTION_KEY must be a base64url-encoded 32-byte value");
  }
  if (raw.byteLength !== 32) throw new Error("OAUTH_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
