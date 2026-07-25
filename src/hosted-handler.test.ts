import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleHostedRequest } from "./hosted-handler.js";
import { MemoryOAuthStore } from "./oauth-store.js";

const options = {
  encryptionKey: Buffer.alloc(32, 4).toString("base64url"),
  proxySecret: "private-proxy-secret",
};

describe("hosted reverse-proxy protection", () => {
  it("keeps the health endpoint available to the platform", async () => {
    const response = await handleHostedRequest(
      new Request("https://jpdcl.azurewebsites.net/health"),
      new MemoryOAuthStore(),
      options,
    );
    assert.equal(response.status, 200);
  });

  it("hides every non-health endpoint without the proxy secret", async () => {
    const response = await handleHostedRequest(
      new Request("https://jpdcl.azurewebsites.net/.well-known/oauth-protected-resource"),
      new MemoryOAuthStore(),
      options,
    );
    assert.equal(response.status, 404);
  });

  it("accepts requests forwarded by the trusted proxy", async () => {
    const response = await handleHostedRequest(
      new Request("https://jpdcl.azurewebsites.net/.well-known/oauth-protected-resource", {
        headers: { "x-jpdcl-proxy-secret": options.proxySecret },
      }),
      new MemoryOAuthStore(),
      options,
    );
    assert.equal(response.status, 200);
  });

  it("publishes a static OAuth server card with the complete hosted tool catalog", async () => {
    const response = await handleHostedRequest(
      new Request("https://jpdcl.azurewebsites.net/.well-known/mcp/server-card.json", {
        headers: { "x-jpdcl-proxy-secret": options.proxySecret },
      }),
      new MemoryOAuthStore(),
      { ...options, includeSmartTools: true },
    );
    assert.equal(response.status, 200);

    const card = await response.json() as {
      authentication: { required: boolean; schemes: string[] };
      tools: Array<{ name: string }>;
    };
    assert.deepEqual(card.authentication, { required: true, schemes: ["oauth2"] });
    assert.equal(card.tools.length, 24);
    assert.equal(card.tools.some(({ name }) => name === "jpdcl_smart_billing"), false);
    assert.equal(card.tools.some(({ name }) => name === "jpdcl_smart_nearby_offices"), false);
  });
});
