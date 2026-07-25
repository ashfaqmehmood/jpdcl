import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Credentials } from "./credentials.js";
import { createJpdclPublicMcpServer } from "./public-mcp.js";
import { JpdclRuntime } from "./runtime.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "Access-Control-Expose-Headers": "mcp-protocol-version, mcp-session-id",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function mcpPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function handleMcpRequest(
  request: Request,
  context: { credentials: Credentials; smartFetch?: typeof fetch; includeSmartTools?: boolean },
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const runtime = await JpdclRuntime.create({
    credentials: context.credentials,
    persistent: false,
    allowMutations: false,
    smartFetch: context.smartFetch,
  });
  const server = createJpdclPublicMcpServer(runtime, { includeSmartTools: context.includeSmartTools });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}
