import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticateMcpRequest, handleOAuthRequest, pkceChallenge, unauthorizedMcpResponse } from "./oauth.js";
import { MemoryOAuthStore } from "./oauth-store.js";

const origin = "https://jpdcl.example.test";
const redirectUri = "https://chatgpt.com/connector/oauth/test-callback";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const encryptionKey = Buffer.alloc(32, 7).toString("base64url");

describe("OAuth account linking", () => {
  it("publishes MCP OAuth discovery metadata", async () => {
    const store = new MemoryOAuthStore();
    const response = await route(new Request(`${origin}/.well-known/oauth-protected-resource`), store);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["jpdcl:read"],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/privacy`,
    });
  });

  it("links through authorization code + PKCE without exposing credentials to MCP configuration", async () => {
    const store = new MemoryOAuthStore();
    const registration = await route(new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri] }),
    }), store);
    assert.equal(registration.status, 201);
    const client = await registration.json() as { client_id: string };

    const challenge = await pkceChallenge(verifier);
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state: "state-123",
      scope: "jpdcl:read",
      resource: `${origin}/mcp`,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const linkPage = await route(new Request(authorize), store);
    const page = await linkPage.text();
    assert.equal(linkPage.status, 200);
    const contentSecurityPolicy = linkPage.headers.get("content-security-policy") ?? "";
    assert.match(contentSecurityPolicy, /form-action 'self' https:\/\/chatgpt\.com(?:;|\s)/);
    assert.match(contentSecurityPolicy, /script-src 'nonce-[A-Za-z0-9_-]+'/);
    assert.doesNotMatch(contentSecurityPolicy, /script-src 'unsafe-inline'/);
    assert.doesNotMatch(page, /x-jpdcl-password/i);
    assert.match(page, /data-link-form/);
    assert.match(page, /class="button-busy"/);
    assert.match(page, /Linking account…/);
    assert.match(page, /classList\.add\("is-submitting"\)/);
    assert.match(page, /event\.preventDefault\(\)/);
    assert.match(page, /form\.requestSubmit\(\)/);
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(page)?.[1];
    assert.ok(transactionId);

    const linked = await route(new Request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        login_id: "demo-user",
        password: "demo-password",
        consent: "approved",
      }),
    }), store);
    assert.equal(linked.status, 302);
    const callback = new URL(linked.headers.get("location")!);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get("state"), "state-123");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await route(new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        resource: `${origin}/mcp`,
        code,
        code_verifier: verifier,
      }),
    }), store);
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.doesNotMatch(JSON.stringify(tokens), /demo-password/);

    const credentials = await authenticateMcpRequest(new Request(`${origin}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }), store, encryptionKey);
    assert.deepEqual(credentials, { loginId: "demo-user", password: "demo-password", source: "oauth" });

    const refreshedResponse = await route(new Request(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        resource: `${origin}/mcp`,
        refresh_token: tokens.refresh_token,
      }),
    }), store);
    assert.equal(refreshedResponse.status, 200);
    const refreshed = await refreshedResponse.json() as { access_token: string; refresh_token: string };
    assert.notEqual(refreshed.access_token, tokens.access_token);
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

    const refreshReplay = await route(new Request(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        resource: `${origin}/mcp`,
        refresh_token: tokens.refresh_token,
      }),
    }), store);
    assert.equal(refreshReplay.status, 400);

    const replay = await route(new Request(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        resource: `${origin}/mcp`,
        code,
        code_verifier: verifier,
      }),
    }), store);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as { error: string }).error, "invalid_grant");

    const revoked = await route(new Request(`${origin}/oauth/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: refreshed.refresh_token }),
    }), store);
    assert.equal(revoked.status, 200);
    assert.equal(await authenticateMcpRequest(new Request(`${origin}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }), store, encryptionKey), undefined);
  });

  it("accepts authorization requests when resource is omitted", async () => {
    const store = new MemoryOAuthStore();
    const registration = await route(new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Perplexity", redirect_uris: [redirectUri] }),
    }), store);
    const client = await registration.json() as { client_id: string };
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "jpdcl:read",
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();

    const linkPage = await route(new Request(authorize), store);
    assert.equal(linkPage.status, 200);
  });

  it("accepts token exchange requests when resource is omitted", async () => {
    const store = new MemoryOAuthStore();
    const registration = await route(new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Perplexity", redirect_uris: [redirectUri] }),
    }), store);
    const client = await registration.json() as { client_id: string };
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "jpdcl:read",
      resource: `${origin}/mcp`,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    const linkPage = await route(new Request(authorize), store);
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(await linkPage.text())?.[1];
    assert.ok(transactionId);

    const linked = await route(new Request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        login_id: "demo-user",
        password: "demo-password",
        consent: "approved",
      }),
    }), store);
    const callback = new URL(linked.headers.get("location")!);
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await route(new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    }), store);
    assert.equal(tokenResponse.status, 200);
  });

  it("rejects explicit wrong resource values", async () => {
    const store = new MemoryOAuthStore();
    const registration = await route(new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Perplexity", redirect_uris: [redirectUri] }),
    }), store);
    const client = await registration.json() as { client_id: string };
    const badAuthorize = new URL(`${origin}/oauth/authorize`);
    badAuthorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "jpdcl:read",
      resource: `${origin}/not-mcp`,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    const badAuthorizeResponse = await route(new Request(badAuthorize), store);
    assert.equal(badAuthorizeResponse.status, 400);
    assert.equal((await badAuthorizeResponse.json() as { error: string }).error, "invalid_target");

    const goodAuthorize = new URL(`${origin}/oauth/authorize`);
    goodAuthorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "jpdcl:read",
      resource: `${origin}/mcp`,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    const linkPage = await route(new Request(goodAuthorize), store);
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(await linkPage.text())?.[1];
    assert.ok(transactionId);

    const linked = await route(new Request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        login_id: "demo-user",
        password: "demo-password",
        consent: "approved",
      }),
    }), store);
    const callback = new URL(linked.headers.get("location")!);
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const badTokenResponse = await route(new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        resource: `${origin}/not-mcp`,
        code,
        code_verifier: verifier,
      }),
    }), store);
    assert.equal(badTokenResponse.status, 400);
    assert.equal((await badTokenResponse.json() as { error: string }).error, "invalid_request");
  });

  it("allows only the registered loopback callback origin in the linking-page CSP", async () => {
    const store = new MemoryOAuthStore();
    const loopbackRedirect = "http://127.0.0.1:19876/mcp/oauth/callback";
    const registration = await route(new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Codex", redirect_uris: [loopbackRedirect] }),
    }), store);
    const client = await registration.json() as { client_id: string };
    const authorize = new URL(`${origin}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: loopbackRedirect,
      scope: "jpdcl:read",
      resource: `${origin}/mcp`,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();

    const linkPage = await route(new Request(authorize), store);
    const policy = linkPage.headers.get("content-security-policy") ?? "";
    assert.match(policy, /form-action 'self' http:\/\/127\.0\.0\.1:19876(?:;|\s)/);
    assert.doesNotMatch(policy, /127\.0\.0\.1:\*/);
  });

  it("returns a discoverable bearer challenge for unauthenticated MCP requests", () => {
    const response = unauthorizedMcpResponse(new Request(`${origin}/mcp`));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
  });
});

async function route(request: Request, store: MemoryOAuthStore): Promise<Response> {
  const response = await handleOAuthRequest(request, store, {
    encryptionKey,
    appsChallenge: "challenge-token",
    validateCredentials: async (credentials) => {
      assert.equal(credentials.loginId, "demo-user");
      assert.equal(credentials.password, "demo-password");
    },
  });
  assert.ok(response);
  return response;
}
