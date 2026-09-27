/**
 * Durable Streams contract (architecture §12.4). Every `DurableStreams` runs
 * this suite: the in-memory fake and the S2 adapter on s2-lite. Each test uses
 * a new Tenant and deletes it afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  CONTROL_STREAM,
  WORK_AVAILABLE,
  WORK_STREAM,
  sessionStream,
  type DurableStreams,
  type StreamRecord,
} from "../../src/streams/types.js";

export interface StreamsHarness {
  streams: DurableStreams;
  /** Called after the test's Tenants are deleted and `streams.close()`. */
  dispose?(): Promise<void>;
}

export type StreamsFactory = () => Promise<StreamsHarness>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect<T>(
  iterable: AsyncIterable<StreamRecord<T>>,
  until: (records: StreamRecord<T>[]) => boolean = () => false,
): Promise<StreamRecord<T>[]> {
  const records: StreamRecord<T>[] = [];
  for await (const record of iterable) {
    records.push(record);
    if (until(records)) break;
  }
  return records;
}

function withTimeout<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`timed out after ${ms}ms`);
    }),
  ]);
}

export function streamsContract(name: string, factory: StreamsFactory): void {
  describe(`DurableStreams contract: ${name}`, () => {
    let harness: StreamsHarness | undefined;
    const tenants: string[] = [];

    afterEach(async () => {
      if (!harness) return;
      for (const tenantId of tenants.splice(0))
        await harness.streams.deleteTenant(tenantId).catch(() => {});
      await harness.streams.close();
      await harness.dispose?.();
      harness = undefined;
    });

    async function fresh(): Promise<{ streams: DurableStreams; tenantId: string }> {
      harness ??= await factory();
      const tenantId = newTenantId();
      tenants.push(tenantId);
      await harness.streams.ensureTenant(tenantId);
      await harness.streams.ensureTenant(tenantId);
      return { streams: harness.streams, tenantId };
    }

    it("names streams", () => {
      expect(sessionStream("abc", "i1")).toBe("sessions/abc/i1");
      expect(WORK_STREAM).toBe("tenant/work");
      expect(CONTROL_STREAM).toBe("tenant/control");
    });

    it("numbers records from 0 and reports the tail", async () => {
      const { streams, tenantId } = await fresh();
      const stream = sessionStream("s1", "i1");
      expect(await streams.tail(tenantId, stream)).toBe(0);
      expect(await streams.append(tenantId, stream, [{ n: 0 }])).toEqual({
        status: "ok",
        start: 0,
        end: 1,
      });
      expect(
        await streams.append(tenantId, stream, [{ n: 1 }, { n: 2 }, "three", [4], null]),
      ).toEqual({ status: "ok", start: 1, end: 6 });
      expect(await streams.tail(tenantId, stream)).toBe(6);
      const records = await collect(streams.read(tenantId, stream, 0, { follow: false }));
      expect(records.map((r) => [r.seq, r.body])).toEqual([
        [0, { n: 0 }],
        [1, { n: 1 }],
        [2, { n: 2 }],
        [3, "three"],
        [4, [4]],
        [5, null],
      ]);
      for (const record of records) expect(typeof record.timestamp).toBe("number");
    });

    it("appends with matchSeq only at the tail and reports the tail on mismatch", async () => {
      const { streams, tenantId } = await fresh();
      const stream = sessionStream("s1", "i1");
      expect(await streams.append(tenantId, stream, [{ seq: 0 }], { matchSeq: 0 })).toEqual({
        status: "ok",
        start: 0,
        end: 1,
      });
      // A retry of an append whose acknowledgement was lost is rejected, not duplicated.
      expect(await streams.append(tenantId, stream, [{ seq: 0 }], { matchSeq: 0 })).toEqual({
        status: "seq_mismatch",
        tail: 1,
      });
      expect(await streams.append(tenantId, stream, [{ seq: 5 }], { matchSeq: 5 })).toEqual({
        status: "seq_mismatch",
        tail: 1,
      });
      expect(
        await streams.append(tenantId, stream, [{ seq: 1 }, { seq: 2 }], { matchSeq: 1 }),
      ).toEqual({ status: "ok", start: 1, end: 3 });
      expect(await streams.tail(tenantId, stream)).toBe(3);
      const records = await collect(streams.read(tenantId, stream, 0, { follow: false }));
      expect(records.map((r) => r.body)).toEqual([{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
    });

    it("rejects a conditional append on a missing stream unless matchSeq is 0", async () => {
      const { streams, tenantId } = await fresh();
      expect(await streams.append(tenantId, sessionStream("s1", "i1"), [1], { matchSeq: 3 })).toEqual({
        status: "seq_mismatch",
        tail: 0,
      });
      expect(await streams.tail(tenantId, sessionStream("s1", "i1"))).toBe(0);
    });

    it("reads history from a sequence without following", async () => {
      const { streams, tenantId } = await fresh();
      const stream = sessionStream("s1", "i1");
      await streams.append(tenantId, stream, [0, 1, 2, 3, 4]);
      const records = await collect(streams.read<number>(tenantId, stream, 3, { follow: false }));
      expect(records.map((r) => [r.seq, r.body])).toEqual([
        [3, 3],
        [4, 4],
      ]);
      expect(
        await collect(streams.read(tenantId, stream, 5, { follow: false })),
      ).toEqual([]);
      expect(
        await collect(streams.read(tenantId, sessionStream("missing", "i1"), 0, { follow: false })),
      ).toEqual([]);
    });

    it("resumes from a cursor with no gap between history and live records", async () => {
      const { streams, tenantId } = await fresh();
      const stream = sessionStream("s1", "i1");
      await streams.append(tenantId, stream, [0, 1, 2, 3, 4]);
      const controller = new AbortController();
      const reading = collect(
        streams.read<number>(tenantId, stream, 3, { signal: controller.signal }),
        (records) => records.at(-1)!.seq >= 11,
      );
      for (let n = 5; n < 12; n += 1) {
        await streams.append(tenantId, stream, [n], { matchSeq: n });
        if (n % 2 === 0) await sleep(5);
      }
      const records = await withTimeout(reading);
      controller.abort();
      expect(records.map((r) => r.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(records.map((r) => r.body)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it("delivers live records to several readers and ends a read on abort", async () => {
      const { streams, tenantId } = await fresh();
      const controller = new AbortController();
      const seen: number[][] = [[], []];
      const readers = seen.map(async (into) => {
        for await (const record of streams.read<{ type: string }>(tenantId, WORK_STREAM, 0, {
          signal: controller.signal,
        }))
          into.push(record.seq);
      });
      await sleep(50);
      await streams.append(tenantId, WORK_STREAM, [WORK_AVAILABLE]);
      await streams.append(tenantId, WORK_STREAM, [WORK_AVAILABLE]);
      await withTimeout(
        (async () => {
          while (seen.some((s) => s.length < 2)) await sleep(10);
        })(),
      );
      controller.abort();
      await withTimeout(Promise.all(readers));
      expect(seen).toEqual([
        [0, 1],
        [0, 1],
      ]);
    });

    it("waits for the first record of a stream that does not exist yet", async () => {
      const { streams, tenantId } = await fresh();
      const controller = new AbortController();
      const reading = collect(
        streams.read(tenantId, CONTROL_STREAM, 0, { signal: controller.signal }),
        (records) => records.length === 1,
      );
      await sleep(50);
      await streams.append(tenantId, CONTROL_STREAM, [{ type: "session.cancel", sessionId: "s1" }]);
      const records = await withTimeout(reading);
      controller.abort();
      expect(records.map((r) => r.body)).toEqual([{ type: "session.cancel", sessionId: "s1" }]);
    });

    it("keeps Tenants and streams apart", async () => {
      const a = await fresh();
      const b = await fresh();
      await a.streams.append(a.tenantId, sessionStream("s1", "i1"), ["a"]);
      await b.streams.append(b.tenantId, sessionStream("s1", "i1"), ["b1", "b2"]);
      await a.streams.append(a.tenantId, sessionStream("s2", "i1"), ["other"]);
      expect(await a.streams.tail(a.tenantId, sessionStream("s1", "i1"))).toBe(1);
      expect(await b.streams.tail(b.tenantId, sessionStream("s1", "i1"))).toBe(2);
      const records = await collect(
        a.streams.read(a.tenantId, sessionStream("s1", "i1"), 0, { follow: false }),
      );
      expect(records.map((r) => r.body)).toEqual(["a"]);
    });

    it("rejects an empty append and an append for a Tenant without a basin", async () => {
      const { streams, tenantId } = await fresh();
      await expect(streams.append(tenantId, WORK_STREAM, [])).rejects.toThrow();
      await expect(streams.append(newTenantId(), WORK_STREAM, [1])).rejects.toThrow();
    });

    it("lists a Tenant's streams by prefix, without deleted ones", async () => {
      const { streams, tenantId } = await fresh();
      expect(await streams.listStreams(newTenantId(), "sessions/")).toEqual([]);
      await streams.append(tenantId, sessionStream("s2", "b"), [1]);
      await streams.append(tenantId, sessionStream("s1", "a"), [1]);
      await streams.append(tenantId, sessionStream("s10", "c"), [1]);
      await streams.append(tenantId, WORK_STREAM, [WORK_AVAILABLE]);
      expect(await streams.listStreams(tenantId, "sessions/")).toEqual([
        "sessions/s1/a",
        "sessions/s10/c",
        "sessions/s2/b",
      ]);
      expect(await streams.listStreams(tenantId, "sessions/s1/")).toEqual(["sessions/s1/a"]);
      await streams.deleteStream(tenantId, sessionStream("s1", "a"));
      expect(await streams.listStreams(tenantId, "sessions/s1/")).toEqual([]);
    });

    it("deletes a stream and a Tenant", async () => {
      const { streams, tenantId } = await fresh();
      await streams.append(tenantId, sessionStream("s1", "i1"), [1, 2]);
      await streams.append(tenantId, sessionStream("s2", "i1"), [1]);
      await streams.deleteStream(tenantId, sessionStream("s1", "i1"));
      await streams.deleteStream(tenantId, sessionStream("s1", "i1"));
      expect(await streams.tail(tenantId, sessionStream("s1", "i1"))).toBe(0);
      expect(await streams.tail(tenantId, sessionStream("s2", "i1"))).toBe(1);
      await streams.deleteTenant(tenantId);
      await streams.deleteTenant(tenantId);
      await expect(streams.append(tenantId, sessionStream("s2", "i1"), [1])).rejects.toThrow();
    });
  });
}
