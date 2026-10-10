import { expect, it } from "vitest";
import { createPostgresReadStore } from "../../src/store/postgres/reads.js";
import { createPostgresReadClient } from "../../src/store/postgres/connect.js";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { shippedMigrations } from "../../src/store/postgres/migrate.js";
import { emptyTestDatabase, testPool } from "../support/database.js";
import { newTenantId } from "@nylorun/core/compatibility";
import { readCursor } from "../../src/reads/cursor.js";
import { createPostgresTenantOpener } from "../../src/tenant/store-pg.js";
import { configForRoot } from "../tenant/support.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadStore } from "../../src/reads/types.js";

const insert = (sql: ReturnType<typeof testPool>, id: string) => sql`
  insert into nylorun.model_usage (id,effect_key,session_id,turn_id,agent_id,input_tokens,output_tokens,total_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,cost_usd,duplicate,created_at)
  values (${id},${id},'s','t','bot',0,0,0,0,0,0,0,false,'2026-01-01T00:00:00.000Z')`;

it("exports safe transaction order across held transactions, rollback and restart", async () => {
  const sql = testPool();
  const tenant = newTenantId();
  let reads = createPostgresReadStore(sql, tenant);
  const held = await sql.reserve();
  try {
    await held`begin`;
    await insert(held, "earlier-held");
    await insert(sql, "later-committed");
    expect((await reads.exportModel(undefined, 1)).calls).toEqual([]);
    await held`commit`;
    // Transaction IDs are cluster-wide, so a transaction in another test file's database can
    // hold the horizon between the two rows. Wait until both are safe; the horizon only advances.
    await expect
      .poll(async () => (await reads.exportModel(undefined, 2)).calls.map((c) => c.id), {
        timeout: 10_000,
      })
      .toEqual(["earlier-held", "later-committed"]);
    const first = await reads.exportModel(undefined, 1);
    expect(first.calls.map((c) => c.id)).toEqual(["earlier-held"]);
    expect(first.caughtUp).toBe(false);
    await reads.close();
    reads = createPostgresReadStore(sql, tenant);
    const second = await reads.exportModel(first.next!, 1);
    expect(second.calls.map((c) => c.id)).toEqual(["later-committed"]);
    expect(second.caughtUp).toBe(true);
    await held`begin`;
    await insert(held, "rolled-back");
    await insert(sql, "after-rollback");
    expect((await reads.exportModel(second.next!, 200)).calls).toEqual([]);
    await held`rollback`;
    await expect
      .poll(async () => (await reads.exportModel(second.next!, 200)).calls.map((c) => c.id), {
        timeout: 10_000,
      })
      .toEqual(["after-rollback"]);
    // xid8 is preserved as decimal text beyond JS's safe integer range.
    const large = readCursor(tenant, "model-export", {}).encode(["9007199254740993", "z"]);
    expect((await reads.exportModel(large, 200)).calls).toEqual([]);
  } finally {
    await held`rollback`;
    held.release();
    await reads.close();
  }
});

it("keeps legacy timestamps and quality unknown while making old ledger rows exportable", async () => {
  const db = await emptyTestDatabase();
  const tenantId = newTenantId();
  const options = { sql: db.sql, create: { tenantId, name: "legacy", principals: () => [] } };
  const old = await openTenantDatabase({
    ...options,
    // The database as it was before the session reads migration.
    migrations: shippedMigrations().slice(
      0,
      shippedMigrations().findIndex((migration) => migration.tag === "0012_session_reads"),
    ),
  });
  await old.store.close();
  await db.sql`insert into nylorun.sessions (id,body) values ('legacy', '{"agentId":"bot","ownerUserId":"ann","status":"idle"}')`;
  await insert(db.sql, "legacy-call");
  const upgraded = await openTenantDatabase(options);
  const reads = createPostgresReadStore(db.sql, tenantId);
  try {
    expect((await reads.sessions({}, { limit: 50 }, {})).sessions[0]!.createdAt).toBeNull();
    await expect
      .poll(async () => (await reads.exportModel(undefined, 200)).calls.length, { timeout: 10_000 })
      .toBe(1);
    const exported = await reads.exportModel(undefined, 200);
    expect(exported.calls[0]).toMatchObject({
      id: "legacy-call",
      usage: { tokensReported: null, costKnown: null },
    });
    await db.sql`insert into nylorun.sessions (id,body) values ('new', '{"agentId":"bot","ownerUserId":"ann","status":"idle"}')`;
    expect((await reads.sessions({}, { limit: 50 }, {})).sessions[0]!.createdAt).not.toBeNull();
  } finally {
    await reads.close();
    await upgraded.store.close();
  }
});

it("bounds the separate pool, rejects writes, times out statements and closes connections", async () => {
  const pool = createPostgresReadClient(testPool());
  expect(pool.options.max).toBe(4);
  try {
    expect((await pool`show statement_timeout`)[0]!.statement_timeout).toBe("2s");
    expect((await pool`show default_transaction_read_only`)[0]!.default_transaction_read_only).toBe(
      "on",
    );
    await expect(
      pool`insert into nylorun.sessions (id,body) values ('forbidden','{}')`,
    ).rejects.toMatchObject({ code: "25006" });
    await expect(pool`select pg_sleep(3)`).rejects.toMatchObject({ code: "57014" });
  } finally {
    await pool.end({ timeout: 2 });
  }
  await expect(pool`select 1`).rejects.toMatchObject({ code: "CONNECTION_ENDED" });
});

it("maps a blocked read to a bounded timeout and rejects malformed typed cursor keys", async () => {
  const sql = testPool();
  const tenant = newTenantId();
  const reads = createPostgresReadStore(sql, tenant);
  const held = await sql.reserve();
  try {
    const bad = readCursor(tenant, "sessions", {}).encode(["not-a-date", "id"]);
    await expect(reads.sessions({}, { limit: 1, cursor: bad }, {})).rejects.toMatchObject({
      status: 400,
    });
    await held`begin`;
    await held`lock nylorun.sessions in access exclusive mode`;
    await expect(reads.sessions({}, { limit: 1 }, {})).rejects.toMatchObject({ status: 503 });
  } finally {
    await held`rollback`;
    held.release();
    await reads.close();
  }
});

it("closes the read pool when Runtime initialization fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-reads-failure-"));
  const db = await emptyTestDatabase();
  let reads: ReadStore | undefined;
  const open = createPostgresTenantOpener({
    hostRoot: root,
    sql: db.sql,
    create: { name: "failed", principals: () => [] },
    configFor: configForRoot(root),
    openRuntime: async (_config, opened) => {
      reads = opened.reads!;
      await reads.sessions({}, { limit: 1 }, {}); // actually open a connection
      throw new Error("initialization failed");
    },
  });
  try {
    await expect(open()).rejects.toThrow();
    await expect(reads!.sessions({}, { limit: 1 }, {})).rejects.toMatchObject({
      code: "CONNECTION_ENDED",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
