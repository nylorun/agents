import { afterAll, afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { decodeCursor } from "../../src/record/index.js";
import {
  assertLogicalReplication,
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import { lockSessions } from "../../src/store/postgres/locking.js";
import { expectedSchemaVersion } from "../../src/store/postgres/migrate.js";
import { TENANT_SCHEMA } from "../../src/store/postgres/schema.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { SessionStore } from "../../src/store/types.js";
import { STACK_ENABLED } from "../stack/endpoints.js";
import { tenantTestDatabase } from "../support/database.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pools: PostgresClient[] = [];
/** Another pool on a Tenant's database, as another process would hold. */
function newPool(url: string, max = 10): PostgresClient {
  const sql = createPostgresClient(url, { max });
  pools.push(sql);
  return sql;
}

afterAll(async () => {
  await Promise.all(pools.map((sql) => sql.end({ timeout: 5 })));
});

/** A fresh Tenant: the one Tenant of a database of its own, cloned from the migrated template. */
async function freshTenant(): Promise<{ tenantId: string; sql: PostgresClient; url: string }> {
  const tenantId = newTenantId();
  const { sql, url } = await tenantTestDatabase();
  // The Tenant's row, as the bootstrap writes it when it creates the Tenant.
  const now = new Date().toISOString();
  await sql`
    INSERT INTO ${sql(`${TENANT_SCHEMA}.tenant`)} (id, name, created_at, updated_at, schema_version)
    VALUES (${tenantId}, 'Test', ${now}, ${now}, ${expectedSchemaVersion()})`;
  return { tenantId, sql, url };
}

const session = (id: string) => ({
  id,
  agentId: "agent-a",
  status: "idle",
  activeTurnId: null,
});

// The store contract runs on Postgres in the unit suite (`contracts/store.test.ts`).
describe.skipIf(!STACK_ENABLED)("Postgres Session Store", () => {
  describe("beyond the contract", () => {
    const cleanup: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const step of cleanup.splice(0).reverse()) await step();
    });

    async function open(): Promise<{
      store: SessionStore;
      schema: string;
      sql: PostgresClient;
      url: string;
    }> {
      const { tenantId, sql, url } = await freshTenant();
      const store = createPostgresSessionStore({ sql, tenantId });
      cleanup.push(() => store.close());
      return { store, schema: TENANT_SCHEMA, sql, url };
    }

    it("has no sequence gaps with 20 concurrent writers on two pools", async () => {
      const { store: first, url } = await open();
      const second = createPostgresSessionStore({
        sql: newPool(url, 5),
        tenantId: first.tenantId,
      });
      cleanup.push(() => second.close());
      await first.tx((t) => t.put("sessions", "s1", session("s1")));
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 === 0 ? first : second).tx(async (t) => {
            const a = await t.event("s1", null, "turn.completed", { tag: "w", output: { i } });
            await sleep(i % 4);
            const b = await t.event("s1", null, "turn.completed", { tag: "w", output: { i, second: true } });
            if (i % 7 === 3) throw new Error(`fail ${i}`);
            return [a, b] as LiveEvent[];
          }),
        ),
      );
      const committed = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      expect(committed).toHaveLength(17);
      const seqs = committed
        .flat()
        .map((e) => decodeCursor("s1", e.cursor))
        .sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 34 }, (_, i) => i));
      for (const [a, b] of committed)
        expect(decodeCursor("s1", b!.cursor)).toBe(decodeCursor("s1", a!.cursor) + 1);
      const rows = await first.record().readRange(first.tenantId, "s1", 0, 100);
      expect(rows.map((r) => r.seq)).toEqual(seqs);
    });

    it("locks several sessions in id order so opposite orders do not deadlock", async () => {
      const { store } = await open();
      await store.tx(async (t) => {
        for (const id of ["a", "b", "c"]) await t.put("sessions", id, session(id));
      });
      const runs = await Promise.all(
        [["a", "b", "c"], ["c", "b", "a"], ["b", "c", "a", "b"]].map((ids) =>
          store.tx(async (t) => {
            const locked = await lockSessions(t, ids);
            await sleep(20);
            for (const id of locked.keys()) await t.event(id, null, "turn.completed", { tag: "locked", output: { ids } });
            return [...locked.keys()];
          }),
        ),
      );
      expect(runs).toEqual([
        ["a", "b", "c"],
        ["a", "b", "c"],
        ["a", "b", "c"],
      ]);
      const missing = await store.tx((t) => lockSessions(t, ["zz", "a"]));
      expect([...missing.entries()].map(([id, s]) => [id, s?.id])).toEqual([
        ["a", "a"],
        ["zz", undefined],
      ]);
      const heads = await store.record().heads(undefined, 100);
      expect(heads.map((h) => [h.sessionId, h.head])).toEqual([
        ["a", 3],
        ["b", 3],
        ["c", 3],
      ]);
    });

    it("deadlocks when two transactions lock sessions in opposite orders", async () => {
      // Why `lockSessions` exists: Postgres aborts one of the two with 40P01.
      const { store } = await open();
      await store.tx(async (t) => {
        await t.put("sessions", "a", session("a"));
        await t.put("sessions", "b", session("b"));
      });
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const lockBoth = (first: string, second: string) =>
        store.tx(async (t) => {
          await t.lockSession(first);
          if (++arrived === 2) release();
          await barrier;
          await t.lockSession(second);
        });
      const results = await Promise.allSettled([lockBoth("a", "b"), lockBoth("b", "a")]);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "40P01",
      });
    });

    it("keeps Tenant databases apart", async () => {
      const { store: one } = await open();
      const { store: two } = await open();
      await one.tx((t) => t.put("sessions", "s1", session("s1")));
      expect(await two.tx((t) => t.get("sessions", "s1"))).toBeUndefined();
      expect(await two.tx((t) => t.counts())).toMatchObject({ sessions: 0 });
    });

    it("finds logical replication on the test stack", async () => {
      const { sql } = await open();
      await expect(assertLogicalReplication(sql)).resolves.toBeUndefined();
    });

    it("reports health against the schema version", async () => {
      const { store, schema, sql } = await open();
      const latest = expectedSchemaVersion();
      expect(await store.health()).toEqual({
        ok: true,
        schemaVersion: latest,
        expectedSchemaVersion: latest,
      });
      // A migration of a newer Runtime in the journal.
      await sql`INSERT INTO ${sql(`${schema}.__drizzle_migrations`)} (hash, created_at) VALUES ('future', 0)`;
      expect(await store.health()).toMatchObject({ ok: false, schemaVersion: latest + 1 });
      await sql`DROP SCHEMA ${sql(schema)} CASCADE`;
      expect(await store.health()).toMatchObject({ ok: false, schemaVersion: 0 });
    });

    it("keeps store-managed columns out of the body", async () => {
      const { store, schema, sql } = await open();
      await store.tx((t) =>
        t.put("sessions", "s1", { ...session("s1"), owner: "x", epoch: 3 }),
      );
      await store.tx((t) => t.event("s1", null, "turn.completed", { tag: "x", output: {} }));
      const [row] = await sql`
        SELECT body, status, agent_id, epoch
        FROM ${sql(`${schema}.sessions`)} WHERE id = 's1'`;
      expect(row!.body).toEqual(session("s1"));
      expect(row).toMatchObject({ status: "idle", agent_id: "agent-a", epoch: "0" });
    });

    it("stores bodies verbatim and derives columns through doc(), which jsonb escapes cannot break", async () => {
      const { store, schema, sql } = await open();
      const body = {
        ...session("s1"),
        status: "idle\u0000",
        agentId: "agent\ud800",
        text: "a\u0000b\\u0000",
      };
      await store.tx((t) => t.put("sessions", "s1", body));
      const [row] = await sql`
        SELECT body::text AS text, status, agent_id FROM ${sql(`${schema}.sessions`)} WHERE id = 's1'`;
      expect(row!.text).toBe(JSON.stringify(body));
      // Only the derived columns see U+FFFD for the escapes jsonb rejects.
      expect(row).toMatchObject({ status: "idle\ufffd", agent_id: "agent\ufffd" });
      expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject(body);
    });
  });
});
