import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { FileOAuthStore } from "./file-oauth-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("file OAuth storage", () => {
  test("persists values across instances and consumes a code once", async () => {
    const filename = await temporaryStore();
    const first = new FileOAuthStore(filename);
    await first.put("client:one", { name: "Codex" });
    await first.put("code:one", { grantId: "grant-one", expiresAt: Date.now() + 60_000 });

    const second = new FileOAuthStore(filename);
    assert.deepEqual(await second.get("client:one"), { name: "Codex" });
    const consumed = await second.consume<{ grantId: string; expiresAt: number }>("code:one");
    assert.equal(consumed?.grantId, "grant-one");
    assert.equal(typeof consumed?.expiresAt, "number");
    assert.equal(await second.consume("code:one"), undefined);
  });

  test("removes expired records and every token belonging to a revoked grant", async () => {
    const store = new FileOAuthStore(await temporaryStore());
    await store.put("expired", { expiresAt: Date.now() - 1 });
    await store.put("grant:one", { grantId: "one", expiresAt: Date.now() + 60_000 });
    await store.put("access:one", { grantId: "one", expiresAt: Date.now() + 60_000 });
    await store.put("refresh:one", { grantId: "one", expiresAt: Date.now() + 60_000 });
    await store.put("grant:two", { grantId: "two", expiresAt: Date.now() + 60_000 });

    assert.equal(await store.get("expired"), undefined);
    await store.revokeGrant("one");
    assert.equal(await store.get("grant:one"), undefined);
    assert.equal(await store.get("access:one"), undefined);
    assert.equal(await store.get("refresh:one"), undefined);
    assert.notEqual(await store.get("grant:two"), undefined);
  });

  test("serializes concurrent writes without losing records", async () => {
    const filename = await temporaryStore();
    const store = new FileOAuthStore(filename);
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.put(`key:${index}`, { index })));
    const reloaded = new FileOAuthStore(filename);
    const values = await Promise.all(Array.from({ length: 20 }, (_, index) => reloaded.get<{ index: number }>(`key:${index}`)));
    assert.deepEqual(values.map((value) => value?.index), Array.from({ length: 20 }, (_, index) => index));
  });
});

async function temporaryStore(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jpdcl-oauth-test-"));
  directories.push(directory);
  return path.join(directory, "oauth-state.json");
}
