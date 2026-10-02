import { afterAll, afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { decodeCursor } from "../../src/record/index.js";
import {
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import { lockSessions } from "../../src/store/postgres/locking.js";
import {
  POSTGRES_SCHEMA_VERSION,
  migrateSchema,
} from "../../src/store/postgres/migrations/index.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { migrateStreamsSchema } from "../../src/store/postgres/migrations/shared/index.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { SessionStore } from "../../src/store/types.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let client: PostgresClient | undefined;
const pools: PostgresClient[] = [];
function pool(): PostgresClient {
  return (client ??= newPool());
}
function newPool(max = 10): PostgresClient {
  const sql = createPostgresClient(stackEndpoints().postgres.url, { max });
  pools.push(sql);
  return sql;
}

afterAll(async () => {
  await Promise.all(pools.map((sql) => sql.end({ timeout: 5 })));
});

/** A fresh, migrated Tenant schema and its store; dropped by `drop`. */
async function freshSchema(): Promise<{ tenantId: string; schema: string }> {
  const tenantId = newTenantId();
  const schema = tenantSchemaName(tenantId);
  await migrateStreamsSchema(pool());
  await migrateSchema(pool(), schema);
  await insertTenantRow(schema, tenantId);
  return { tenantId, schema };
}

/** The Tenant's row, as the catalog writes it when it creates the Tenant. */
async function insertTenantRow(schema: string, tenantId: string): Promise<void> {
  const sql = pool();
  const now = new Date().toISOString();
  await sql`
    INSERT INTO ${sql(`${schema}.tenant`)} (id, name, created_at, updated_at, schema_version)
    VALUES (${tenantId}, 'Test', ${now}, ${now}, ${POSTGRES_SCHEMA_VERSION})`;
}

async function drop(schema: string): Promise<void> {
  const sql = pool();
  await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
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

    async function open(sql = pool()): Promise<{
      store: SessionStore;
      schema: string;
    }> {
      const { tenantId, schema } = await freshSchema();
      const store = createPostgresSessionStore({ sql, tenantId, schema });
      cleanup.push(() => drop(schema));
      cleanup.push(() => store.close());
      return { store, schema };
    }

    it("has no sequence gaps with 20 concurrent writers on two pools", async () => {
      const { store: first, schema } = await open();
      const second = createPostgresSessionStore({
        sql: newPool(5),
        tenantId: first.tenantId,
        schema,
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

    it("keeps Tenant schemas apart", async () => {
      const { store: one } = await open();
      const { store: two } = await open();
      await one.tx((t) => t.put("sessions", "s1", session("s1")));
      expect(await two.tx((t) => t.get("sessions", "s1"))).toBeUndefined();
      expect(await two.tx((t) => t.counts())).toMatchObject({ sessions: 0 });
    });

    it("reports health against the schema version", async () => {
      const { store, schema } = await open();
      expect(await store.health()).toEqual({
        ok: true,
        schemaVersion: POSTGRES_SCHEMA_VERSION,
        expectedSchemaVersion: POSTGRES_SCHEMA_VERSION,
      });
      const sql = pool();
      await sql`INSERT INTO ${sql(`${schema}.schema_version`)} (version, name) VALUES (99, 'future')`;
      expect(await store.health()).toMatchObject({ ok: false, schemaVersion: 99 });
      await drop(schema);
      expect(await store.health()).toMatchObject({ ok: false, schemaVersion: 0 });
    });

    it("keeps store-managed columns out of the body", async () => {
      const { store, schema } = await open();
      await store.tx((t) =>
        t.put("sessions", "s1", { ...session("s1"), owner: "x", epoch: 3 }),
      );
      await store.tx((t) => t.event("s1", null, "turn.completed", { tag: "x", output: {} }));
      const sql = pool();
      const [row] = await sql`
        SELECT body, status, agent_id, epoch
        FROM ${sql(`${schema}.sessions`)} WHERE id = 's1'`;
      expect(row!.body).toEqual(session("s1"));
      expect(row).toMatchObject({ status: "idle", agent_id: "agent-a", epoch: "0" });
    });

    it("stores bodies verbatim and derives columns through doc(), which jsonb escapes cannot break", async () => {
      const { store, schema } = await open();
      const body = {
        ...session("s1"),
        status: "idle\u0000",
        agentId: "agent\ud800",
        text: "a\u0000b\\u0000",
      };
      await store.tx((t) => t.put("sessions", "s1", body));
      const sql = pool();
      const [row] = await sql`
        SELECT body::text AS text, status, agent_id FROM ${sql(`${schema}.sessions`)} WHERE id = 's1'`;
      expect(row!.text).toBe(JSON.stringify(body));
      // Only the derived columns see U+FFFD for the escapes jsonb rejects.
      expect(row).toMatchObject({ status: "idle\ufffd", agent_id: "agent\ufffd" });
      expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject(body);
    });
  });
});
