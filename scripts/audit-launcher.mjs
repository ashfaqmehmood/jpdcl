import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = new URL("../dist/launcher.js", import.meta.url).pathname;
const cli = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8" });
if (cli.status !== 0 || !cli.stdout.includes("Usage: jpdcl")) {
  throw new Error(`jpdcl CLI dispatch failed: ${cli.stderr || cli.stdout}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [launcher],
  cwd: new URL("..", import.meta.url).pathname,
  stderr: "pipe",
});
const client = new Client({ name: "jpdcl-launcher-audit", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (client.getServerVersion()?.name !== "JPDCL Smart Meter" || tools.tools.length !== 29) {
    throw new Error("jpdcl MCP dispatch returned unexpected server metadata");
  }
  process.stdout.write(`${JSON.stringify({ status: "ok", command: "jpdcl", cli: true, mcp: true, toolCount: tools.tools.length })}\n`);
} finally {
  await client.close();
}
