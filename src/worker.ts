import { DurableOAuthStore, OAuthState, type DurableObjectNamespaceLike } from "./oauth-store.js";
import { handleHostedRequest } from "./hosted-handler.js";

export { OAuthState };

interface WorkerEnv {
  OAUTH_STATE: DurableObjectNamespaceLike;
  OAUTH_ENCRYPTION_KEY: string;
  OPENAI_APPS_CHALLENGE?: string;
  AZURE_ORIGIN?: string;
  AZURE_PROXY_SECRET?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (env.AZURE_ORIGIN || env.AZURE_PROXY_SECRET) {
      if (!env.AZURE_ORIGIN || !env.AZURE_PROXY_SECRET) {
        return Response.json({ error: "proxy_not_configured" }, { status: 503 });
      }
      return proxyToAzure(request, env.AZURE_ORIGIN, env.AZURE_PROXY_SECRET);
    }

    const store = new DurableOAuthStore(env.OAUTH_STATE);
    return handleHostedRequest(request, store, {
      encryptionKey: env.OAUTH_ENCRYPTION_KEY,
      appsChallenge: env.OPENAI_APPS_CHALLENGE,
    });
  },
};

async function proxyToAzure(request: Request, originValue: string, proxySecret: string): Promise<Response> {
  const origin = new URL(originValue);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    return Response.json({ error: "proxy_not_configured" }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, origin);
  const headers = new Headers(request.headers);
  headers.set("x-jpdcl-proxy-secret", proxySecret);
  return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
}
