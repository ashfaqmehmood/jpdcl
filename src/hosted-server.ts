#!/usr/bin/env node
import { serve } from "@hono/node-server";
import path from "node:path";
import process from "node:process";
import { FileOAuthStore } from "./file-oauth-store.js";
import { handleHostedRequest } from "./hosted-handler.js";

const encryptionKey = requireEnvironment("OAUTH_ENCRYPTION_KEY");
const publicOrigin = process.env.JPDCL_PUBLIC_ORIGIN?.trim()
  || (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : undefined);
const dataRoot = process.env.JPDCL_DATA_DIR?.trim() || (process.env.HOME ? path.join(process.env.HOME, "data") : path.resolve(".data"));
const store = new FileOAuthStore(path.join(dataRoot, "oauth-state.json"));
const port = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 8080);
const hostname = process.env.JPDCL_HOSTED_HOST?.trim() || "0.0.0.0";

if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("PORT must be a valid TCP port");

serve({
  hostname,
  port,
  fetch: (request) => handleHostedRequest(request, store, {
    encryptionKey,
    publicOrigin,
    appsChallenge: process.env.OPENAI_APPS_CHALLENGE,
    includeSmartTools: process.env.JPDCL_HOSTED_SMART_TOOLS?.toLowerCase() === "true",
    proxySecret: process.env.JPDCL_PROXY_SECRET?.trim(),
  }),
}, (info) => {
  process.stderr.write(`JPDCL hosted OAuth MCP listening on port ${info.port}\n`);
});

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
