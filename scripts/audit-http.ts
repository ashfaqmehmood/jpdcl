import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/http-handler.js";

const listener = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const server = serve({
    fetch: (request) => handleMcpRequest(request, {
      credentials: { loginId: "audit-user", password: "audit-password", source: "oauth" },
    }),
    port: 0,
  }, () => resolve(server));
});
const address = listener.address();
if (!address || typeof address === "string") throw new Error("Could not start HTTP audit server");

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
const client = new Client({ name: "jpdcl-http-audit", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  const forbidden = ["jpdcl_auth_login", "jpdcl_mutate", "jpdcl_read"]
    .filter((name) => names.includes(name));
  const incomplete = tools.tools.filter((tool) =>
    !tool.title || !tool.description || !tool.outputSchema
    || tool.annotations?.readOnlyHint !== true
    || tool.annotations?.destructiveHint !== false);
  if (client.getServerVersion()?.name !== "JPDCL Smart Meter (Unofficial)" || tools.tools.length !== 10) {
    throw new Error("HTTP endpoint returned unexpected MCP metadata");
  }
  if (forbidden.length || incomplete.length) {
    throw new Error(JSON.stringify({ forbidden, incomplete: incomplete.map((tool) => tool.name) }));
  }
  process.stdout.write(`${JSON.stringify({ status: "ok", transport: "streamable-http", oauth: true, readOnly: true, toolCount: tools.tools.length })}\n`);
} finally {
  await client.close();
  listener.close();
}
