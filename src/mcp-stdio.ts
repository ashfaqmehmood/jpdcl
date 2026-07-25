#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJpdclMcpServer } from "./mcp.js";

const server = await createJpdclMcpServer();
await server.connect(new StdioServerTransport());
