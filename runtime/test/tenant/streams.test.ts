import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { LiveEvent } from "@nylorun/core/contracts";
import { decodeCursor } from "../../src/store/cursor.js";
import { createSqliteSessionStore } from "../../src/store/sqlite.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { startTestTenant } from "../support/tenant.js";
import { tenantStreamsSuite } from "./streams.suite.js";

tenantStreamsSuite("memory streams", async () => ({ streams: new MemoryStreams() }));

describe("interim streams on SQLite (until Wave 3)", () => {
  const APP = "server-token-value-aaaaaaaa";
  const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
  const roots: string[] = [];
  const open: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const node of open.splice(0)) await node.close().catch(() => {});
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function items(url: string) {
    const response = await fetch(`${url}/v1/sessions/s1/items`, { headers });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: LiveEvent[] }).items;
  }

  async function turn(url: string, id: string, count: number) {
    const response = await fetch(`${url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "message", requestId: id, idempotencyKey: id, content: id }),
    });
    expect(response.status).toBe(200);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const events = await items(url);
      if (events.filter((e) => e.type === "turn.completed").length >= count) return events;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("turn did not complete");
  }

  it("re-hydrates history from SQLite after a restart and drains unrelayed rows", async () => {
    const first = await startTestTenant({ applicationKey: APP, retainRoot: true });
    roots.push(first.root);
    open.push(first);
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    await fetch(`${first.url}/v1/agents/bot`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ requestId: "a", manifest: agent.manifest, implementationVersion: "dev" }),
    });
    await fetch(`${first.url}/v1/sessions/s1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ requestId: "s", agentId: "bot", ownerUserId: "ada" }),
    });
    const before = await turn(first.url, "m1", 1);
    await first.close();

    // A row committed without a relay (a crash between commit and append) stays in the outbox.
    const store = createSqliteSessionStore({
      path: tenantPaths(first.root, first.tenantId).database,
      tenantId: first.tenantId,
    });
    const offline = await store.tx((t) => t.event("s1", null, "test.offline", {}));
    await store.close();

    const second = await startTestTenant({
      applicationKey: APP,
      hostRoot: first.root,
      tenantId: first.tenantId,
    });
    open.push(second);
    expect(await items(second.url)).toEqual([...before, offline]);
    const after = await turn(second.url, "m2", 2);
    expect(after.map((e) => decodeCursor("s1", e.cursor))).toEqual(after.map((_, i) => i));
  });
});
