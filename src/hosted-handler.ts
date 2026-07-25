import { handleMcpRequest, mcpPreflightResponse } from "./http-handler.js";
import { authenticateMcpRequest, handleOAuthRequest, unauthorizedMcpResponse } from "./oauth.js";
import type { OAuthStore } from "./oauth-store.js";
import { JpdclRuntime } from "./runtime.js";

export interface HostedHandlerOptions {
  encryptionKey: string;
  appsChallenge?: string;
  publicOrigin?: string;
  includeSmartTools?: boolean;
  proxySecret?: string;
}

export async function handleHostedRequest(
  request: Request,
  store: OAuthStore,
  options: HostedHandlerOptions,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  if (
    options.proxySecret
    && incomingUrl.pathname !== "/health"
    && request.headers.get("x-jpdcl-proxy-secret") !== options.proxySecret
  ) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const externalRequest = options.publicOrigin ? replaceOrigin(request, options.publicOrigin) : request;
  const url = new URL(externalRequest.url);
  const oauthResponse = await handleOAuthRequest(externalRequest, store, {
    encryptionKey: options.encryptionKey,
    appsChallenge: options.appsChallenge,
    validateCredentials: async (credentials) => {
      const runtime = await JpdclRuntime.create({ credentials, persistent: false, allowMutations: false });
      await runtime.login(credentials.loginId, credentials.password);
    },
  });
  if (oauthResponse) return oauthResponse;

  if (url.pathname === "/mcp") {
    if (externalRequest.method === "OPTIONS") return mcpPreflightResponse();
    const credentials = await authenticateMcpRequest(externalRequest, store, options.encryptionKey);
    if (!credentials) return unauthorizedMcpResponse(externalRequest);
    return handleMcpRequest(externalRequest, { credentials, includeSmartTools: options.includeSmartTools });
  }

  if (url.pathname === "/health" && externalRequest.method === "GET") {
    return Response.json({ ok: true, service: "jpdcl-mcp" });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

function replaceOrigin(request: Request, publicOrigin: string): Request {
  const incoming = new URL(request.url);
  const external = new URL(`${incoming.pathname}${incoming.search}`, normalizeOrigin(publicOrigin));
  return new Request(external, request);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error("JPDCL_PUBLIC_ORIGIN must use HTTPS (localhost may use HTTP)");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("JPDCL_PUBLIC_ORIGIN must be an origin without a path, credentials, query, or fragment");
  }
  return url.origin;
}
