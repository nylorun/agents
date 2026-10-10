/**
 * Durable Streams failure cases (Durable Streams §13, §20) on the test stack's Postgres
 * (logical replication) and s2-lite: the stream relay keeps every S2 stream equal to the
 * record through a relay crash, an S2 outage, a slot Postgres invalidated, and a takeover by
 * another process.
 *
 * Each test has its own Tenant (in a database of its own), basin prefix and replication slot.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createPgoutputSource } from "../../src/adapters/replication/pgoutput.js";
import { createS2Streams } from "../../src/adapters/streams/s2.js";
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import { createStreamRelay, type StreamRelay } from "../../src/streams/relay/core.js";
import { sessionStream, type DurableStreams } from "../../src/streams/types.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import { tenantTestDatabase } from "../support/database.js";
import { recordOf, recordedRows, writeRecord } from "../support/record.js";
import { tcpProxy } from "./support.js";

describe.skipIf(!STACK_ENABLED)("Durable Streams failures on Postgres and s2-lite", () => {
  const s2Port = Number(new URL(stackEndpoints().s2.endpoint).port);
  // The test's database: set by `setup`.
  let url: string;
  let sql: PostgresClient;
  const slots: string[] = [];
  const relays: StreamRelay[] = [];
  const cleanups: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.stop().catch(() => undefined);
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
    // A logical slot is dropped from its own database, and keeps the database from being dropped.
    for (const slot of slots.splice(0))
      await sql`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
                WHERE slot_name = ${slot} AND NOT active`.catch(() => undefined);
  });

  async function setup(options: { endpoint?: string } = {}) {
    ({ sql, url } = await tenantTestDatabase());
    const id = randomBytes(4).toString("hex");
    const tenantId = newTenantId();
    const slot = `nylorun_test_${id}`;
    slots.push(slot);
    const streams = createS2Streams({
      endpoint: options.endpoint ?? stackEndpoints().s2.endpoint,
      basinPrefix: `dsf${id}-`,
    });
    // The basin is deleted through a direct connection (a proxy may be down by then).
    const admin = createS2Streams({ endpoint: stackEndpoints().s2.endpoint, basinPrefix: `dsf${id}-` });
    cleanups.push(async () => {
      await admin.deleteTenant(tenantId, { allGenerations: true });
      await admin.close();
      await streams.close();
    });
    await streams.ensureTenant(tenantId);
    const relay = () => {
      const r = createStreamRelay({
        source: createPgoutputSource({ connectionString: url, tenantId, slot, retryMs: 200 }),
        record: recordOf(sql, tenantId),
        streams,
      });
      relays.push(r);
      r.start();
      return r;
    };
    return { tenantId, slot, streams, admin, relay };
  }

  /** Every session's S2 stream equals its record, `0..head-1` in order. */
  async function expectStreamsEqualRecord(streams: DurableStreams, tenantId: string) {
    const record = await recordedRows(sql, tenantId);
    expect(record.size).toBeGreaterThan(0);
    for (const [sessionId, rows] of record) {
      const inS2: unknown[] = [];
      for await (const r of streams.read(tenantId, sessionStream(sessionId), 0, { follow: false }))
        inS2.push(r.body);
      expect(inS2).toEqual(rows.map((row) => row.body));
      expect(rows.map((row) => row.seq)).toEqual(rows.map((_, i) => i));
    }
  }

  async function until(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function caughtUp(streams: DurableStreams, tenantId: string): Promise<boolean> {
    for (const [sessionId, rows] of await recordedRows(sql, tenantId))
      if ((await streams.tail(tenantId, sessionStream(sessionId))) !== rows.length) return false;
    return true;
  }

  it("keeps S2 equal to the record when the relay crashes mid-stream", async () => {
    const t = await setup();
    const first = t.relay();
    await until("the relay to be active", () => first.status().active);
    const sessions = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const writing = Promise.all(
      sessions.map(async (sessionId) => {
        for (let i = 0; i < 25; i += 1) await writeRecord(sql, sessionId);
      }),
    );
    // Crash while writes and appends are in flight.
    await until("the relay to be appending", async () => (await recordedRows(sql, t.tenantId)).size >= 10);
    await first.stop();
    const second = t.relay();
    await writing;
    await until("S2 to catch up", () => caughtUp(t.streams, t.tenantId));
    await expectStreamsEqualRecord(t.streams, t.tenantId);
    expect(second.status().lastError).toBeNull();
  });

  it("keeps committing while S2 is unreachable for 10 s, then catches up in order", async () => {
    const proxy = await tcpProxy(s2Port);
    cleanups.push(() => proxy.close());
    const t = await setup({ endpoint: proxy.endpoint });
    const relay = t.relay();
    await until("the relay to be active", () => relay.status().active);
    await writeRecord(sql, "s1", 3);
    await until("three events in S2", () => caughtUp(t.streams, t.tenantId));
    const [{ lsn: before }] = await sql<{ lsn: string }[]>`
      SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name = ${t.slot}`;

    await proxy.down();
    const started = Date.now();
    let commits = 0;
    while (Date.now() - started < 10_000) {
      await writeRecord(sql, commits % 2 ? "s1" : "s2", 2);
      commits += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(commits).toBeGreaterThan(50);
    // Nothing reached S2, so the slot did not move past those commits.
    const [{ lsn: during }] = await sql<{ lsn: string }[]>`
      SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name = ${t.slot}`;
    expect(during).toBe(before);
    expect(relay.status().pendingTxs).toBeGreaterThan(0);

    await proxy.up();
    await until("S2 to catch up", () => caughtUp(t.streams, t.tenantId));
    await expectStreamsEqualRecord(t.streams, t.tenantId);
  });

  it("recreates a slot Postgres invalidated for holding too much WAL, and reconciles", async () => {
    const t = await setup();
    const first = t.relay();
    await until("the relay to be active", () => first.status().active);
    await writeRecord(sql, "s1", 2);
    await until("two events in S2", () => caughtUp(t.streams, t.tenantId));
    await first.stop();

    // While no relay runs: more events, then enough WAL past a 1 MB cap to lose the slot.
    await writeRecord(sql, "s1", 3);
    await writeRecord(sql, "s2", 2);
    await sql`ALTER SYSTEM SET max_slot_wal_keep_size = '1MB'`;
    await sql`SELECT pg_reload_conf()`;
    cleanups.push(async () => {
      await sql`ALTER SYSTEM RESET max_slot_wal_keep_size`;
      await sql`SELECT pg_reload_conf()`;
    });
    const scratch = `nylorun_test_wal_${randomBytes(3).toString("hex")}`;
    cleanups.push(() => sql.unsafe(`DROP TABLE IF EXISTS ${scratch}`));
    await until("the slot to be lost", async () => {
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS ${scratch} AS SELECT repeat('x', 2000) AS v FROM generate_series(1, 0);
         INSERT INTO ${scratch} SELECT repeat('x', 2000) FROM generate_series(1, 2000)`,
      );
      await sql`SELECT pg_switch_wal()`;
      await sql`CHECKPOINT`;
      const [row] = await sql<{ wal_status: string | null }[]>`
        SELECT wal_status FROM pg_replication_slots WHERE slot_name = ${t.slot}`;
      return row?.wal_status === "lost";
    }, 60_000);
    await sql`ALTER SYSTEM RESET max_slot_wal_keep_size`;
    await sql`SELECT pg_reload_conf()`;

    const second = t.relay();
    await until("S2 to catch up", () => caughtUp(t.streams, t.tenantId));
    await expectStreamsEqualRecord(t.streams, t.tenantId);
    expect(second.status().reconciliations).toBe(1);
    const [row] = await sql<{ wal_status: string }[]>`
      SELECT wal_status FROM pg_replication_slots WHERE slot_name = ${t.slot}`;
    expect(row?.wal_status).not.toBe("lost");
  });

  it("hands the slot to another process when the active relay's connection dies", async () => {
    const t = await setup();
    const a = t.relay();
    await until("a to be active", () => a.status().active);
    const b = t.relay();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(b.status().active).toBe(false);
    await writeRecord(sql, "s1", 3);
    await until("three events in S2", () => caughtUp(t.streams, t.tenantId));

    // The active relay's replication connection is killed (a crashed process).
    await a.stop();
    await until("b to take over", () => b.status().active, 15_000);
    await writeRecord(sql, "s1", 3);
    await until("six events in S2", () => caughtUp(t.streams, t.tenantId));
    await expectStreamsEqualRecord(t.streams, t.tenantId);
  });
});
