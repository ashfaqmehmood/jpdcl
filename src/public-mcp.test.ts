import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJpdclPublicMcpServer } from "./public-mcp.js";
import type { JpdclRuntime } from "./runtime.js";

describe("hosted MCP catalog", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("advertises only tools that do not require Genus smart-meter access", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createJpdclPublicMcpServer({} as JpdclRuntime);
    const client = new Client({ name: "hosted-catalog-test", version: "1.0.0" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "jpdcl_account_digest",
      "jpdcl_account_info",
      "jpdcl_bills",
      "jpdcl_catalog",
      "jpdcl_consumption",
      "jpdcl_energy_ledger",
      "jpdcl_guide",
      "jpdcl_payments",
      "jpdcl_tariff_estimate",
      "jpdcl_tariff_schedule",
    ]);
    assert.equal(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
    assert.equal(listed.tools.every((tool) => tool.annotations?.destructiveHint === false), true);
  });

  it("adds every hosted read-only smart-meter tool when the host enables them", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createJpdclPublicMcpServer({} as JpdclRuntime, { includeSmartTools: true });
    const client = new Client({ name: "smart-hosted-catalog-test", version: "1.0.0" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "jpdcl_account_digest",
      "jpdcl_account_info",
      "jpdcl_bills",
      "jpdcl_catalog",
      "jpdcl_consumption",
      "jpdcl_energy_ledger",
      "jpdcl_guide",
      "jpdcl_meter_health",
      "jpdcl_payments",
      "jpdcl_read",
      "jpdcl_smart_alerts",
      "jpdcl_smart_consumption",
      "jpdcl_smart_dashboard",
      "jpdcl_smart_forecasts",
      "jpdcl_smart_intervals",
      "jpdcl_smart_meter_profile",
      "jpdcl_smart_notifications",
      "jpdcl_smart_preferences",
      "jpdcl_smart_report",
      "jpdcl_smart_session",
      "jpdcl_smart_support",
      "jpdcl_snapshot",
      "jpdcl_tariff_estimate",
      "jpdcl_tariff_schedule",
    ]);
    assert.equal(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
    assert.equal(listed.tools.every((tool) => tool.annotations?.destructiveHint === false), true);
  });
});
