/**
 * Relay behaviour (architecture §12.4 and §17): runs on the in-memory streams
 * (`relay.test.ts`) and on s2-lite (`relay.integration.test.ts`). The Session
 * Store is the in-memory fake in both. `FaultyStreams` wraps the real streams
 * to simulate S2 outages and lost acknowledgements.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LiveEvent } from "@nylorun/core/contracts";
import { newTenantId } from "@nylorun/core/compatibility";
import { MemorySessionStore } from "../../src/store/memory.js";
import { createRelay, signalCancel, type Relay } from "../../src/streams/relay.js";
import {
  CONTROL_STREAM,
  newStreamIncarnation,
  streamOfSession,
  type AppendOptions,
  type AppendResult,
  type DurableStreams,
  type ReadOptions,
  type StreamRecord,
} from "../../src/streams/types.js";

export interface RelayHarness {
  streams: DurableStreams;
  dispose?(): Promise<void>;
}

/** Passes calls through to `inner`, failing appends on demand. */
export class FaultyStreams implements DurableStreams {
  /** Every append throws before reaching the streams. */
  down = false;
  /** The next N appends reach the streams, then throw as if the ack was lost. */
  loseAcks = 0;
  appends = 0;
  /** Runs before each append reaches the streams. */
  beforeAppend?: (stream: string) => Promise<void>;

  constructor(private readonly inner: DurableStreams) {}

  async append(
    tenantId: string,
    stream: string,
    records: readonly unknown[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    this.appends += 1;
    if (this.down) throw new Error("S2 unreachable");
    await this.beforeAppend?.(stream);
    const result = await this.inner.append(tenantId, stream, records, options);
    if (this.loseAcks > 0) {
      this.loseAcks -= 1;
      throw new Error("connection reset before the acknowledgement");
    }
    return result;
  }
  read<T = unknown>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    options?: ReadOptions,
  ): AsyncIterable<StreamRecord<T>> {
    return this.inner.read<T>(tenantId, stream, fromSeq, options);
  }
  tail(tenantId: string, stream: string) {
    return this.inner.tail(tenantId, stream);
  }
  ensureTenant(tenantId: string) {
    return this.inner.ensureTenant(tenantId);
  }
  deleteTenant(tenantId: string) {
    return this.inner.deleteTenant(tenantId);
  }
  deleteStream(tenantId: string, stream: string) {
    return this.inner.deleteStream(tenantId, stream);
  }
  listStreams(tenantId: string, prefix: string) {
    return this.inner.listStreams(tenantId, prefix);
  }
  close() {
    return this.inner.close();
  }
}

function sessionDoc(id: string) {
  return {
    id,
    agentId: "agent-a",
    ownerUserId: "user-1",
    status: "idle",
    activeTurnId: null,
    streamIncarnation: newStreamIncarnation(),
  };
}

export function relaySuite(name: string, factory: () => Promise<RelayHarness>): void {
  describe(`outbox relay: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function setup(sessions: string[] = ["s1"]) {
      const harness = await factory();
      const tenantId = newTenantId();
      const faulty = new FaultyStreams(harness.streams);
      const storeErrors: unknown[] = [];
      const relayErrors: unknown[] = [];
      const store = new MemorySessionStore({
        tenantId,
        onError: (error) => storeErrors.push(error),
      });
      await harness.streams.ensureTenant(tenantId);
      await store.tx(async (t) => {
        for (const id of sessions) await t.put("sessions", id, sessionDoc(id));
      });
      const relays: Relay[] = [];
      const relay = (options: { streams?: DurableStreams } = {}) => {
        const r = createRelay({
          store,
          streams: options.streams ?? faulty,
          tenantId,
          onError: (error) => relayErrors.push(error),
        });
        relays.push(r);
        return r;
      };
      cleanups.push(async () => {
        for (const r of relays) await r.close();
        await store.close();
        await harness.streams.deleteTenant(tenantId).catch(() => {});
        await harness.streams.close();
        await harness.dispose?.();
        expect(storeErrors).toEqual([]);
      });

      /** Commits one transaction writing `types` as events of `sessionId`. */
      async function commit(sessionId: string, ...types: string[]): Promise<LiveEvent[]> {
        return store.tx(async (t) => {
          const events: LiveEvent[] = [];
          for (const type of types)
            events.push(await t.event(sessionId, "turn-1", type, { type }));
          return events;
        });
      }

      /** The session's current stream. */
      async function streamOf(sessionId: string): Promise<string> {
        const session = await store.tx((t) => t.get("sessions", sessionId));
        if (!session) throw new Error(`Session ${sessionId} not found`);
        return streamOfSession(session);
      }

      async function read(stream: string): Promise<StreamRecord<LiveEvent>[]> {
        const records: StreamRecord<LiveEvent>[] = [];
        for await (const record of harness.streams.read<LiveEvent>(tenantId, stream, 0, {
          follow: false,
        }))
          records.push(record);
        return records;
      }

      /** The records of the session's current stream. */
      async function history(sessionId: string): Promise<StreamRecord<LiveEvent>[]> {
        return read(await streamOf(sessionId));
      }

      /** Deletes the session (and its outbox rows) and creates it again: a new incarnation. */
      async function recreate(sessionId: string): Promise<void> {
        await store.tx((t) => t.delete("sessions", sessionId));
        await store.tx((t) => t.put("sessions", sessionId, sessionDoc(sessionId)));
      }

      const outbox = () => store.tx((t) => t.outbox(10_000));

      return {
        streams: harness.streams,
        faulty,
        store,
        tenantId,
        relay,
        commit,
        streamOf,
        read,
        history,
        recreate,
        outbox,
        relayErrors,
      };
    }

    it("appends committed events at their sequence and empties the outbox", async () => {
      const { relay, commit, history, outbox, relayErrors } = await setup(["s1", "s2"]);
      const r = relay();
      const first = await commit("s1", "a", "b");
      await commit("s2", "x");
      const third = await commit("s1", "c");
      await r.idle();
      const records = await history("s1");
      expect(records.map((record) => [record.seq, record.body.type])).toEqual([
        [0, "a"],
        [1, "b"],
        [2, "c"],
      ]);
      expect(records.map((record) => record.body)).toEqual([...first, ...third]);
      expect((await history("s2")).map((record) => record.body.type)).toEqual(["x"]);
      expect(await outbox()).toEqual([]);
      expect(relayErrors).toEqual([]);
    });

    it("yields exactly one event when an append is retried after an unacknowledged success", async () => {
      const { faulty, relay, commit, history, outbox, relayErrors } = await setup();
      const r = relay();
      faulty.loseAcks = 1;
      await commit("s1", "only");
      await r.idle();
      // The append landed but the relay saw a failure: the row stays.
      expect(relayErrors).toHaveLength(1);
      expect((await outbox()).map((row) => row.seq)).toEqual([0]);
      // The sweep retries: `matchSeq` 0 finds the tail at 1 and deletes the row.
      expect(await r.drain()).toBe(1);
      expect(await outbox()).toEqual([]);
      expect((await history("s1")).map((record) => [record.seq, record.body.type])).toEqual([
        [0, "only"],
      ]);
      // A second retry of the same rows is a no-op.
      expect(await r.drain()).toBe(0);
      expect(await history("s1")).toHaveLength(1);
    });

    it("recovers a lost acknowledgement on the session's next commit", async () => {
      const { faulty, relay, commit, history, outbox } = await setup();
      const r = relay();
      faulty.loseAcks = 1;
      await commit("s1", "a", "b");
      await r.idle();
      await commit("s1", "c");
      await r.idle();
      expect((await history("s1")).map((record) => [record.seq, record.body.type])).toEqual([
        [0, "a"],
        [1, "b"],
        [2, "c"],
      ]);
      expect(await outbox()).toEqual([]);
    });

    it("drains earlier rows first when a commit finds a gap", async () => {
      const { faulty, relay, commit, history, outbox, relayErrors } = await setup();
      const r = relay();
      faulty.down = true;
      await commit("s1", "a");
      await commit("s1", "b", "c");
      await r.idle();
      expect(relayErrors).toHaveLength(2);
      expect((await outbox()).map((row) => row.seq)).toEqual([0, 1, 2]);
      faulty.down = false;
      await commit("s1", "d");
      await r.idle();
      expect((await history("s1")).map((record) => [record.seq, record.body.type])).toEqual([
        [0, "a"],
        [1, "b"],
        [2, "c"],
        [3, "d"],
      ]);
      expect(await outbox()).toEqual([]);
      expect(relayErrors).toHaveLength(2);
    });

    it("keeps events in the outbox while S2 is down and drains them in order afterwards", async () => {
      const { faulty, relay, commit, history, outbox, relayErrors } = await setup(["s1", "s2"]);
      const r = relay();
      faulty.down = true;
      for (let n = 0; n < 5; n += 1) {
        await commit("s1", `s1-${n}`);
        await commit("s2", `s2-${n}a`, `s2-${n}b`);
      }
      await r.idle();
      // State committed; nothing reached the streams.
      expect(relayErrors.length).toBeGreaterThan(0);
      expect(await outbox()).toHaveLength(15);
      expect(await history("s1")).toEqual([]);
      // Still down: drain reports and keeps the rows.
      const errors = relayErrors.length;
      expect(await r.drain()).toBe(0);
      expect(relayErrors.length).toBeGreaterThan(errors);
      expect(await outbox()).toHaveLength(15);
      faulty.down = false;
      expect(await r.drain(4)).toBe(4);
      expect(await r.drain()).toBe(11);
      expect(await outbox()).toEqual([]);
      expect((await history("s1")).map((record) => [record.seq, record.body.type])).toEqual(
        [0, 1, 2, 3, 4].map((n) => [n, `s1-${n}`]),
      );
      expect((await history("s2")).map((record) => record.body.type)).toEqual(
        [0, 1, 2, 3, 4].flatMap((n) => [`s2-${n}a`, `s2-${n}b`]),
      );
    });

    it("relays exactly once when several processes relay the same outbox", async () => {
      const { faulty, relay, commit, history, outbox, relayErrors } = await setup(["s1", "s2"]);
      faulty.down = true;
      const a = relay();
      for (let n = 0; n < 6; n += 1) await commit(n % 2 ? "s1" : "s2", `e${n}`, `f${n}`);
      await a.idle();
      faulty.down = false;
      relayErrors.length = 0;
      // A second relay (another process) sweeps while the first keeps relaying commits.
      const b = relay();
      const sweeps = [a.drain(3), b.drain(), b.drain(5), a.drain()];
      await Promise.all([commit("s1", "late-1"), commit("s2", "late-2"), ...sweeps]);
      await Promise.all([a.idle(), b.idle()]);
      await a.drain();
      expect(await outbox()).toEqual([]);
      const s1 = await history("s1");
      expect(s1.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(s1.map((record) => record.body.type)).toEqual([
        "e1", "f1", "e3", "f3", "e5", "f5", "late-1",
      ]);
      const s2 = await history("s2");
      expect(s2.map((record) => record.body.type)).toEqual([
        "e0", "f0", "e2", "f2", "e4", "f4", "late-2",
      ]);
      // Concurrent drains on s2-lite (createStreamOnAppend) can surface a
      // transient `stream_not_found` on the losing append while the other
      // relay lands the rows. History + empty outbox already prove
      // exactly-once; ignore only that code if nothing else failed.
      expect(
        relayErrors.filter(
          (error) =>
            !(
              error instanceof Error &&
              "code" in error &&
              (error as { code?: string }).code === "stream_not_found"
            ),
        ),
      ).toEqual([]);
    });

    it("splits large commits into several appends", async () => {
      const { faulty, relay, commit, history, outbox, relayErrors } = await setup();
      const r = relay();
      const types = Array.from({ length: 1200 }, (_, n) => `e${n}`);
      await commit("s1", ...types);
      await r.idle();
      expect(faulty.appends).toBeGreaterThanOrEqual(3);
      const records = await history("s1");
      expect(records.map((record) => record.seq)).toEqual(types.map((_, n) => n));
      expect(records.map((record) => record.body.type)).toEqual(types);
      expect(await outbox()).toEqual([]);
      expect(relayErrors).toEqual([]);
    });

    it("reports a gap it cannot fill and leaves the rows", async () => {
      const context = await setup();
      const { streams, tenantId, relay, commit, outbox, relayErrors } = context;
      const r = relay();
      await commit("s1", "a", "b");
      await r.idle();
      // The stream lost its records (deleted under a live session).
      await streams.deleteStream(tenantId, await context.streamOf("s1"));
      await commit("s1", "c");
      await r.idle();
      expect(relayErrors).toHaveLength(1);
      expect(String(relayErrors[0])).toMatch(/missing/);
      expect((await outbox()).map((row) => row.seq)).toEqual([2]);
    });

    it("cancels on the control stream, which relayed commits leave alone", async () => {
      const { streams, tenantId, relay, commit } = await setup();
      const r = relay();
      await commit("s1", "a");
      await r.idle();
      await signalCancel(streams, tenantId, "s1");
      const control: unknown[] = [];
      for await (const record of streams.read(tenantId, CONTROL_STREAM, 0, { follow: false }))
        control.push(record.body);
      expect(control).toEqual([{ type: "session.cancel", sessionId: "s1" }]);
    });

    it("relays a re-created session to its new stream from 0 and drops the old rows", async () => {
      const { faulty, relay, commit, streamOf, read, history, recreate, outbox, relayErrors } =
        await setup();
      const r = relay();
      await commit("s1", "a", "b");
      await r.idle();
      const first = await streamOf("s1");
      // S2 is down while the session is deleted and created again (a reset).
      faulty.down = true;
      await commit("s1", "lost");
      await r.idle();
      await recreate("s1");
      expect(await outbox()).toEqual([]);
      faulty.down = false;
      relayErrors.length = 0;
      await commit("s1", "x", "y");
      await r.idle();
      const second = await streamOf("s1");
      expect(second).not.toBe(first);
      expect((await history("s1")).map((record) => [record.seq, record.body.type])).toEqual([
        [0, "x"],
        [1, "y"],
      ]);
      expect((await read(first)).map((record) => record.body.type)).toEqual(["a", "b"]);
      expect(await outbox()).toEqual([]);
      expect(relayErrors).toEqual([]);
    });

    it("keeps a re-created session's rows when an old incarnation's append lands late", async () => {
      const { faulty, relay, commit, streamOf, read, history, recreate, outbox, relayErrors } =
        await setup();
      const r = relay();
      const first = await streamOf("s1");
      let raced = false;
      faulty.beforeAppend = async (stream) => {
        if (raced || stream !== first) return;
        raced = true;
        // While the old incarnation's append is in flight, the session is reset and gets
        // new events at the same sequences.
        await recreate("s1");
        await commit("s1", "new-0", "new-1");
      };
      await commit("s1", "old-0", "old-1");
      await r.idle();
      expect(raced).toBe(true);
      expect((await read(first)).map((record) => record.body.type)).toEqual(["old-0", "old-1"]);
      expect((await history("s1")).map((record) => [record.seq, record.body.type])).toEqual([
        [0, "new-0"],
        [1, "new-1"],
      ]);
      expect(await outbox()).toEqual([]);
      expect(relayErrors).toEqual([]);
    });

    it("stops relaying after close", async () => {
      const { relay, commit, history, outbox } = await setup();
      const r = relay();
      await r.close();
      await commit("s1", "a");
      expect(await history("s1")).toEqual([]);
      expect(await outbox()).toHaveLength(1);
    });
  });
}
