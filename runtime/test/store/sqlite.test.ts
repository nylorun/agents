import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { decodeCursor, encodeCursor } from "../../src/store/cursor.js";
import { createSqliteSessionStore } from "../../src/store/sqlite.js";
import {
  TENANT_SCHEMA_VERSION,
  withTenantDatabase,
} from "../../src/tenant/schema.js";
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
  withTenantDatabase(path, (db) => {
    db.exec(`
      CREATE TABLE definitions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE commands(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE checkpoints(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE effects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE actions(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE sandboxes(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE links(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE vaults(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'user');
      CREATE TABLE vault_credentials(id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL, binding_json TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, rotated_at TEXT, kek_id TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, wrapped_dek BLOB NOT NULL);
      CREATE TABLE vault_audit(id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, vault_id TEXT, credential_id TEXT, session_id TEXT, target TEXT, outcome TEXT NOT NULL);
      CREATE TABLE vault_idempotency(id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE executors(agent_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, implementation_version TEXT NOT NULL, manifest_hash TEXT, principal_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE principals(id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role = 'application'), token_hash TEXT NOT NULL UNIQUE, idempotency_key TEXT, created_at TEXT NOT NULL);
      CREATE TABLE tenant_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO principals VALUES('pr_1', 'application', 'h1', 'k', 'x');
      PRAGMA user_version = 3;
    `);
    db.prepare("INSERT INTO sessions(id, body) VALUES(?, ?)").run(
      "s1",
      JSON.stringify(session("s1", { status: "running" })),
    );
    db.prepare("INSERT INTO sessions(id, body) VALUES(?, ?)").run(
      "s2",
      JSON.stringify(session("s2")),
    );
    for (const [sid, type] of [["s1", "a"], ["s2", "b"], ["s1", "c"]] as const)
      db.prepare("INSERT INTO events(session_id, body) VALUES(?, ?)").run(
        sid,
        JSON.stringify({ sessionId: sid, type, cursor: "old" }),
      );
  });
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
