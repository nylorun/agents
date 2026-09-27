import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { decodeCursor, encodeCursor } from "../../src/store/cursor.js";
import { createSqliteSessionStore } from "../../src/store/sqlite.js";
import { TENANT_SCHEMA_VERSION } from "../../src/tenant/schema.js";
import { createV3Database } from "../support/sqlite-v3.js";
import { storeContract } from "../contracts/store.contract.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-sqlite-store-"));
  roots.push(root);
  return join(root, "tenant.sqlite");
}

storeContract("sqlite", async (options) => ({
  store: createSqliteSessionStore({ ...options, path: await tempFile() }),
}));

storeContract("sqlite in memory", async (options) => ({
  store: createSqliteSessionStore({ ...options, path: ":memory:" }),
}));

const session = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  agentId: "agent-a",
  status: "idle",
  activeTurnId: null,
  ...fields,
});

it("rejects transactions after close", async () => {
  const store = createSqliteSessionStore({ tenantId: newTenantId(), path: ":memory:" });
  await store.close();
  await expect(store.tx(async () => 1)).rejects.toThrow("closed");
});

it("keeps history after relaying and reads it after a sequence", async () => {
  const store = createSqliteSessionStore({ tenantId: newTenantId(), path: ":memory:" });
  await store.tx((t) => t.put("sessions", "s1", session("s1")));
  await store.tx(async (t) => {
    await t.event("s1", null, "a", 1);
    await t.event("s1", null, "b", 2);
    await t.event("s1", null, "c", 3);
  });
  expect(await store.tx((t) => t.deleteOutbox("s1", 2))).toBe(3);
  expect(await store.tx((t) => t.outbox(10))).toEqual([]);
  const all = await store.readEvents("s1");
  expect(all.events.map((e) => e.type)).toEqual(["a", "b", "c"]);
  expect(all.lastSeq).toBe(2);
  const after = await store.readEvents("s1", 0);
  expect(after.events.map((e) => decodeCursor("s1", e.cursor))).toEqual([1, 2]);
  expect(await store.readEvents("missing")).toEqual({ events: [], lastSeq: null });
  await store.close();
});

it("serializes transactions that lock sessions in opposite orders", async () => {
  // The lock-ordering rule (child before parent) protects Postgres; on SQLite
  // the store runs one transaction at a time, so no order can deadlock.
  const store = createSqliteSessionStore({ tenantId: newTenantId(), path: ":memory:" });
  await store.tx(async (t) => {
    await t.put("sessions", "child", session("child", { n: 0 }));
    await t.put("sessions", "parent", session("parent", { n: 0 }));
  });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.tx(async (t) => {
        const order = i % 2 === 0 ? ["child", "parent"] : ["parent", "child"];
        for (const id of order) {
          const s = await t.lockSession<any>(id);
          await new Promise((resolve) => setTimeout(resolve, 1));
          await t.put("sessions", id, { ...s, n: s.n + 1 });
          await t.event(id, null, "bump", { i });
        }
      }),
    ),
  );
  await store.tx(async (t) => {
    expect((await t.get("sessions", "child")).n).toBe(20);
    expect((await t.get("sessions", "parent")).n).toBe(20);
  });
  expect((await store.readEvents("parent")).lastSeq).toBe(19);
  await store.close();
});

it("migrates a v3 database: per-session sequences and any principal role", async () => {
  const path = await tempFile();
  createV3Database(path);
  const store = createSqliteSessionStore({ tenantId: newTenantId(), path });
  expect(await store.health()).toMatchObject({ ok: true, schemaVersion: TENANT_SCHEMA_VERSION });
  const s1 = await store.readEvents("s1");
  expect(s1.events.map((e) => [e.type, e.cursor])).toEqual([
    ["a", encodeCursor("s1", 0)],
    ["c", encodeCursor("s1", 1)],
  ]);
  await store.tx(async (t) => {
    expect(await t.outbox(10)).toEqual([]);
    expect(decodeCursor("s1", (await t.event("s1", null, "d", {})).cursor)).toBe(2);
    expect(decodeCursor("s2", (await t.event("s2", null, "e", {})).cursor)).toBe(1);
    expect((await t.sessionsWithStatus(["running"])).map((s) => s.id)).toEqual(["s1"]);
    expect(await t.principalById("pr_1")).toMatchObject({ role: "application" });
    await t.insertPrincipal({ id: "studio", role: "studio", tokenHash: "h2", idempotencyKey: null, createdAt: "x" });
  });
  await store.close();
});
