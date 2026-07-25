#!/usr/bin/env node

// MCP clients start the package without arguments. Any explicit argument selects
// the human CLI, so `npx jpdcl` and `jpdcl auth status` can share one executable.
if (process.argv.length > 2) {
  await import("./cli.js");
} else {
  await import("./mcp-stdio.js");
}
