/**
 * The stream relay over the in-memory record (Durable Streams §7, §20): S2 equals the record,
 * replays are harmless, lost streams and slots are refilled from the record, and rows of an
 * old basin generation never reach the new one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { basinOf } from "../../src/streams/basin.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { createStreamRelay, sessionStreamName, type StreamRelay } from "../../src/streams/relay/core.js";
import { MemoryRecord } from "../../src/streams/relay/memory.js";
import type { RecordRow } from "../../src/streams/relay/types.js";
import type { AppendOptions, AppendResult } from "../../src/streams/types.js";

const T = "tn_relay";

class FlakyStreams extends MemoryStreams {
  down = false;
  appends = 0;
  /** Throws after appending, as an append whose acknowledgement was lost. */
  loseNextAck = false;
  override async append(
    tenantId: string,
    stream: string,
    records: readonly unknown[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    if (this.down) throw new Error("S2 unreachable");
    this.appends += 1;
    const result = await super.append(tenantId, stream, records, options);
    if (this.loseNextAck) {
      this.loseNextAck = false;
      throw new Error("connection reset");
    }
    return result;
  }
}

const relays: StreamRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.stop();
});

async function setup(options: { generation?: number } = {}) {
  const record = new MemoryRecord();
  const streams = new FlakyStreams();
  record.setGeneration(T, options.generation ?? 0);
  await streams.ensureTenant(basinOf(T, options.generation ?? 0));
  const seqs = new Map<string, number>();
  const write = (sessionId: string, n = 1, generation = options.generation ?? 0) => {
    const rows: RecordRow[] = [];
    for (let i = 0; i < n; i += 1) {
      const seq = seqs.get(sessionId) ?? 0;
      seqs.set(sessionId, seq + 1);
      rows.push({ tenantId: T, sessionId, seq, generation, body: { sessionId, seq } });
    }
    record.commit(rows);
  };
  const relay = (overrides: { maxBatchRecords?: number } = {}) => {
    const r = createStreamRelay({ source: record.source(), record, streams, ...overrides });
    relays.push(r);
    r.start();
    return r;
  };
  const inS2 = async (sessionId: string, generation = options.generation ?? 0) => {
    const out: number[] = [];
    for await (const r of streams.read<{ seq: number }>(
      basinOf(T, generation),
      sessionStreamName(sessionId),
      0,
      { follow: false },
    ))
      out.push(r.body.seq);
    return out;
  };
  return { record, streams, write, relay, inS2 };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const eventually = async <T>(what: string, check: () => Promise<T | undefined> | T | undefined) => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("stream relay", () => {
  it("appends every committed row at its seq, then acknowledges", async () => {
    const t = await setup();
    const relay = t.relay();
    t.write("s1", 3);
    t.write("s2", 2);
    t.write("s1", 2);
    await relay.idle();
    expect(await t.inS2("s1")).toEqual(range(5));
    expect(await t.inS2("s2")).toEqual(range(2));
    expect(t.record.confirmed()).toBe(3);
    expect(relay.status()).toMatchObject({ active: true, pendingTxs: 0, pendingRows: 0 });
  });

  it("batches contiguous rows within the limits", async () => {
    const t = await setup();
    const relay = t.relay({ maxBatchRecords: 4 });
    t.write("s1", 10);
    await relay.idle();
    expect(await t.inS2("s1")).toEqual(range(10));
    expect(t.streams.appends).toBe(3);
  });

  it("starts fresh on a new slot and reconciles what was committed before it", async () => {
    const t = await setup();
    t.write("s1", 4); // committed before any slot existed
    const relay = t.relay();
    await eventually("the reconciliation", async () => (await t.inS2("s1")).length === 4 || undefined);
    t.write("s1", 1);
    await relay.idle();
    expect(await t.inS2("s1")).toEqual(range(5));
    expect(relay.status().reconciliations).toBe(1);
  });

  it("replays unacknowledged transactions after a crash without duplicating them", async () => {
    const t = await setup();
    const first = t.relay();
    t.write("s1", 2);
    await first.idle();
    t.streams.down = true;
    t.write("s1", 3); // received, not in S2, not acknowledged
    await eventually("the append to fail", () => first.status().lastError ?? undefined);
    await first.stop(); // the crash
    t.streams.down = false;
    const second = t.relay();
    await eventually("the replay", async () => (await t.inS2("s1")).length === 5 || undefined);
    await second.idle();
    expect(await t.inS2("s1")).toEqual(range(5));
    expect(second.status().reconciliations).toBe(0);
  });

  it("acknowledges nothing it has not appended: an append whose ack was lost is retried once", async () => {
    const t = await setup();
    const relay = t.relay();
    t.streams.loseNextAck = true;
    t.write("s1", 2);
    await relay.idle();
    expect(await t.inS2("s1")).toEqual(range(2));
    expect(t.record.confirmed()).toBe(1);
  });

  it("keeps commits while S2 is down and delivers them in order when it returns", async () => {
    const t = await setup();
    const relay = t.relay();
    t.streams.down = true;
    for (let i = 0; i < 5; i += 1) t.write(i % 2 ? "s1" : "s2", 2);
    await eventually("a failed append", () => relay.status().lastError ?? undefined);
    expect(relay.status().pendingTxs).toBe(5);
    expect(t.record.confirmed()).toBe(0);
    t.streams.down = false;
    await relay.idle();
    expect(await t.inS2("s1")).toEqual(range(4));
    expect(await t.inS2("s2")).toEqual(range(6));
    expect(t.record.confirmed()).toBe(5);
  });

  it("re-sends a lost stream from the record on the next commit", async () => {
    const t = await setup();
    const relay = t.relay();
    t.write("s1", 3);
    await relay.idle();
    await t.streams.deleteStream(T, sessionStreamName("s1"));
    t.write("s1", 1);
    await relay.idle();
    expect(await t.inS2("s1")).toEqual(range(4));
  });

  it("recreates a dropped slot and reconciles every session", async () => {
    const t = await setup();
    const relay = t.relay();
    t.write("s1", 2);
    await relay.idle();
    t.record.dropSlot();
    await t.streams.deleteStream(T, sessionStreamName("s1"));
    t.write("s2", 1); // committed while no slot exists: only reconciliation finds it
    await eventually("the reconciliation", async () =>
      (await t.inS2("s1")).length === 2 && (await t.inS2("s2")).length === 1 ? true : undefined,
    );
    // Once for the first slot, once for the new one.
    expect(relay.status().reconciliations).toBe(2);
  });

  it("lets one relay hold the slot; another takes over when it stops", async () => {
    const t = await setup();
    const a = t.relay();
    const b = t.relay();
    t.write("s1", 2);
    await a.idle();
    expect(a.status().active).toBe(true);
    expect(b.status().active).toBe(false);
    await a.stop();
    await eventually("the takeover", () => b.status().active || undefined);
    t.write("s1", 1);
    await b.idle();
    expect(await t.inS2("s1")).toEqual(range(3));
  });

  it("drops rows of an old basin generation instead of writing them to the new basin", async () => {
    const t = await setup();
    const relay = t.relay();
    t.streams.down = true;
    t.write("s1", 2); // generation 0, stuck while S2 is down
    await eventually("a failed append", () => relay.status().lastError ?? undefined);
    // A reset: the Tenant moves to generation 1, its old rows are deleted, and the same id
    // starts again from 0.
    t.record.deleteRows(T);
    t.record.setGeneration(T, 1);
    await t.streams.ensureTenant(basinOf(T, 1));
    t.streams.down = false;
    t.record.commit([{ tenantId: T, sessionId: "s1", seq: 0, generation: 1, body: { sessionId: "s1", seq: 0 } }]);
    await relay.idle();
    expect(await t.inS2("s1", 1)).toEqual([0]);
  });

  it("orders concurrent writers to one session by seq", async () => {
    const t = await setup();
    const relay = t.relay({ maxBatchRecords: 3 });
    let written = 0;
    for (let i = 0; i < 20; i += 1) {
      t.write("s1", 1 + (i % 3));
      written += 1 + (i % 3);
    }
    await relay.idle();
    expect(await t.inS2("s1")).toEqual(range(written));
  });
});
