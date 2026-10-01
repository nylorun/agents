/**
 * The stream relay on Postgres logical replication (Durable Streams §7, §13, §20): rows
 * committed to `nylorun_streams.session_events` reach their streams exactly once and in
 * order, through a crash, an S2 outage, a dropped slot and a second relay.
 *
 * Each test has its own slot and Tenants. Other tests' rows also arrive on the shared
 * publication; the record reader below calls their Tenants gone, so the relay drops them.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgoutputSource } from "../../src/adapters/replication/pgoutput.js";
import { createPostgresClient, type PostgresClient } from "../../src/store/postgres/connect.js";
import { migrateStreamsSchema } from "../../src/store/postgres/migrations/shared/index.js";
import { createPostgresRecordReader } from "../../src/store/postgres/record.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { createStreamRelay, type StreamRelay } from "../../src/streams/relay/core.js";
import { sessionStream } from "../../src/streams/types.js";
import type { RecordReader } from "../../src/streams/relay/types.js";
import type { AppendOptions, AppendResult } from "../../src/streams/types.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

class FlakyStreams extends MemoryStreams {
  down = false;
  override async append(
    basin: string,
    stream: string,
    records: readonly unknown[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    if (this.down) throw new Error("S2 unreachable");
    return super.append(basin, stream, records, options);
  }
}

describe.skipIf(!STACK_ENABLED)("stream relay on logical replication", () => {
  const url = stackEndpoints().postgres.url;
  let sql: PostgresClient;
  const slots: string[] = [];
  const relays: StreamRelay[] = [];

  beforeAll(async () => {
    sql = createPostgresClient(url, { max: 4 });
    await migrateStreamsSchema(sql);
  });

  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.stop();
  });

  afterAll(async () => {
    for (const slot of slots)
      await sql`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
                WHERE slot_name = ${slot} AND NOT active`.catch(() => undefined);
    await sql.end();
  });

  async function setup() {
    const tenantId = `tn_relay_${randomBytes(4).toString("hex")}`;
    const slot = `nylorun_test_${randomBytes(4).toString("hex")}`;
    slots.push(slot);
    const streams = new FlakyStreams();
    await streams.ensureTenant(tenantId);
    const pgRecord = createPostgresRecordReader(sql);
    const record: RecordReader = {
      readRange: (...args) => pgRecord.readRange(...args),
      heads: (...args) => pgRecord.heads(...args),
      generation: async (id) => (id === tenantId ? 0 : undefined),
    };
    const seqs = new Map<string, number>();
    /** One transaction writing `n` events to the session, as `Tx.event` does. */
    const write = async (sessionId: string, n = 1) => {
      await sql.begin(async (tx) => {
        for (let i = 0; i < n; i += 1) {
          const [head] = await tx<{ seq: string }[]>`
            INSERT INTO nylorun_streams.session_log_heads (tenant_id, session_id, generation, head)
            VALUES (${tenantId}, ${sessionId}, 0, 1)
            ON CONFLICT (tenant_id, session_id)
              DO UPDATE SET head = nylorun_streams.session_log_heads.head + 1
            RETURNING head - 1 AS seq`;
          const seq = Number(head!.seq);
          seqs.set(sessionId, seq + 1);
          await tx`
            INSERT INTO nylorun_streams.session_events
              (tenant_id, session_id, seq, generation, type, body)
            VALUES (${tenantId}, ${sessionId}, ${seq}, 0, 'turn.completed',
                    ${JSON.stringify({ sessionId, seq })}::text::json)`;
        }
      });
    };
    const relay = () => {
      const r = createStreamRelay({
        source: createPgoutputSource({ connectionString: url, slot, retryMs: 200 }),
        record,
        streams,
      });
      relays.push(r);
      r.start();
      return r;
    };
    const inS2 = async (sessionId: string) => {
      const out: number[] = [];
      for await (const r of streams.read<{ seq: number }>(tenantId, sessionStream(sessionId), 0, {
        follow: false,
      }))
        out.push(r.body.seq);
      return out;
    };
    const until = async (what: string, check: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 20_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const confirmed = async () => {
      const [row] = await sql<{ lsn: string | null }[]>`
        SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name = ${slot}`;
      return row?.lsn ?? null;
    };
    return { tenantId, slot, streams, write, relay, inS2, until, confirmed };
  }

  const range = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("relays committed rows to S2 at their seq, after reconciling what predates the slot", async () => {
    const t = await setup();
    await t.write("s1", 3); // before the slot exists
    const relay = t.relay();
    await t.until("the relay to be active", () => relay.status().active);
    await t.write("s1", 2);
    await t.write("s2", 4);
    await t.until("every row in S2", async () =>
      (await t.inS2("s1")).length === 5 && (await t.inS2("s2")).length === 4,
    );
    expect(await t.inS2("s1")).toEqual(range(5));
    expect(await t.inS2("s2")).toEqual(range(4));
    const [pending] = await sql<{ reconcile_pending: boolean }[]>`
      SELECT reconcile_pending FROM nylorun_streams.relay_slots WHERE slot_name = ${t.slot}`;
    expect(pending?.reconcile_pending).toBe(false);
  });

  it("replays what a crashed relay received but S2 never got", async () => {
    const t = await setup();
    const first = t.relay();
    await t.until("the relay to be active", () => first.status().active);
    await t.write("s1", 2);
    await t.until("two rows in S2", async () => (await t.inS2("s1")).length === 2);
    t.streams.down = true;
    await t.write("s1", 3);
    await t.until("the relay to hold them", () => first.status().pendingTxs > 0);
    await first.stop(); // the crash: received, never appended, never acknowledged
    t.streams.down = false;
    const second = t.relay();
    await t.until("the replay", async () => (await t.inS2("s1")).length === 5);
    expect(await t.inS2("s1")).toEqual(range(5));
    expect(second.status().reconciliations).toBe(0);
  });

  it("holds the slot while S2 is down and catches up in order", async () => {
    const t = await setup();
    const relay = t.relay();
    await t.until("the relay to be active", () => relay.status().active);
    await t.write("s1", 1);
    await t.until("one row in S2", async () => (await t.inS2("s1")).length === 1);
    const before = await t.confirmed();
    t.streams.down = true;
    for (let i = 0; i < 10; i += 1) await t.write(i % 2 ? "s1" : "s2", 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await t.confirmed()).toBe(before);
    t.streams.down = false;
    await t.until("the catch-up", async () =>
      (await t.inS2("s1")).length === 11 && (await t.inS2("s2")).length === 10,
    );
    expect(await t.inS2("s1")).toEqual(range(11));
    expect(await t.inS2("s2")).toEqual(range(10));
  });

  it("recreates a dropped slot and reconciles", async () => {
    const t = await setup();
    const relay = t.relay();
    await t.until("the relay to be active", () => relay.status().active);
    await t.write("s1", 2);
    await t.until("two rows in S2", async () => (await t.inS2("s1")).length === 2);
    await t.streams.deleteStream(t.tenantId, sessionStream("s1"));
    // Terminate the slot's connection and drop it, as an operator or the WAL cap would.
    await sql`SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots
              WHERE slot_name = ${t.slot} AND active_pid IS NOT NULL`;
    await t.until("the slot to be released", async () => {
      const [row] = await sql<{ active: boolean }[]>`
        SELECT active FROM pg_replication_slots WHERE slot_name = ${t.slot}`;
      if (!row) return true;
      if (row.active) return false;
      await sql`SELECT pg_drop_replication_slot(${t.slot})`.catch(() => undefined);
      return true;
    });
    await t.write("s2", 1);
    await t.until("the reconciliation", async () =>
      (await t.inS2("s1")).length === 2 && (await t.inS2("s2")).length === 1,
    );
    expect(relay.status().reconciliations).toBeGreaterThanOrEqual(2);
  });

  it("lets one relay hold the slot; the other takes over when it stops", async () => {
    const t = await setup();
    const a = t.relay();
    await t.until("a to be active", () => a.status().active);
    const b = t.relay();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(b.status().active).toBe(false);
    await t.write("s1", 2);
    await t.until("two rows in S2", async () => (await t.inS2("s1")).length === 2);
    await a.stop();
    await t.until("b to take over", () => b.status().active);
    await t.write("s1", 1);
    await t.until("three rows in S2", async () => (await t.inS2("s1")).length === 3);
    expect(await t.inS2("s1")).toEqual(range(3));
  });

  it("stops while the slot is still being prepared, and leaves the slot free", async () => {
    const t = await setup();
    const source = createPgoutputSource({ connectionString: url, slot: t.slot, retryMs: 200 });
    let active = false;
    source.start({
      onActive: () => {
        active = true;
      },
      onTx: () => {},
      onKeepalive: () => undefined,
      onInactive: () => {},
    });
    // Before the first attempt's `prepareSlot` has finished.
    const stopped = source.stop().then(() => "stopped" as const);
    const timeout = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000));
    expect(await Promise.race([stopped, timeout])).toBe("stopped");
    expect(active).toBe(false);
    const [row] = await sql<{ active: boolean }[]>`
      SELECT active FROM pg_replication_slots WHERE slot_name = ${t.slot}`;
    expect(row?.active ?? false).toBe(false);
  });

  it("keeps order with concurrent writers on one session", async () => {
    const t = await setup();
    const relay = t.relay();
    await t.until("the relay to be active", () => relay.status().active);
    await Promise.all(range(20).map(() => t.write("s1", 2)));
    await t.until("forty rows in S2", async () => (await t.inS2("s1")).length === 40);
    expect(await t.inS2("s1")).toEqual(range(40));
  });
});
