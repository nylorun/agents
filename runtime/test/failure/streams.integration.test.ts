/**
 * Failure cases of architecture §17 about event order and Durable Streams, on Postgres + Restate
 * + S2 (`README.md`):
 *
 * - §17.5 no sequence gap under concurrent writers;
 * - §17.6 a relay append retried after an unacknowledged success;
 * - §17.7 S2 unavailable;
 * - §17.8 an SSE client reconnecting to a different API node.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../../src/core/provider.js";
import { stackEndpoints } from "../stack/endpoints.js";
import { FaultyStreams } from "../streams/relay.suite.js";
import { openTestSessionStore } from "../support/store.js";
import {
  controlledModel,
  openSession,
  sendMessage,
  server,
  until,
  view,
} from "../host/execution-support.js";
import {
  FULL_STACK,
  FailureTenant,
  completeHistory,
  contextOf,
  countOf,
  range,
  seqsOf,
  sse,
  tcpProxy,
  type Node,
} from "./support.js";

const tenants: FailureTenant[] = [];
afterEach(async () => {
  for (const tenant of tenants.splice(0).reverse()) await tenant.dispose();
});
function failureTenant(): FailureTenant {
  const tenant = new FailureTenant();
  tenants.push(tenant);
  return tenant;
}

const done: ModelProvider = async () => ({ output: [{ type: "text", text: "done" }] });

/** Commits `count` single-event transactions on `node`'s own Postgres pool, all at once. */
function ticks(node: Node, sessionId: string, count: number, from: string) {
  const { store } = contextOf(node);
  return Promise.all(
    range(0, count).map((i) =>
      store.tx((t) => t.event(sessionId, null, "test.tick", { from, i }))
    )
  );
}

describe.skipIf(!FULL_STACK)("§17 stream failures on Postgres, Restate and S2", () => {
  it("§17.5 no sequence gap under concurrent writers on two nodes while turns run", async () => {
    const t = failureTenant();
    const worker = t.worker({ offset: 8, prefix: "gaps" });
    await worker.host.start();
    const a = await t.node({ worker, workerId: "worker-a", modelProvider: done });
    const b = await t.node({
      worker: t.worker({ offset: 8, prefix: "gaps", role: "api" }),
      workerId: "api-b",
      modelProvider: done,
    });
    const sessions = ["s1", "s2", "s3"];
    for (const [i, id] of sessions.entries()) await openSession(i % 2 ? b : a, id, i === 0);

    // Per session: a turn on Restate, and 20 concurrent commits from each node's pool.
    await Promise.all(
      sessions.flatMap((id, i) => [
        sendMessage(i % 2 ? a : b, id),
        ticks(a, id, 20, "a"),
        ticks(b, id, 20, "b"),
      ])
    );
    for (const id of sessions) {
      await until(() => view(a, id), (v) => v.status === "completed", `${id} completed`, 20_000);
      const history = await completeHistory(a, id);
      expect(countOf(history, "test.tick")).toBe(40);
      expect(countOf(history, "turn.completed")).toBe(1);
      expect(await completeHistory(b, id)).toEqual(history);
    }
  });

  it("§17.6 relay appends retried after unacknowledged successes land exactly once", async () => {
    const t = failureTenant();
    // Appends reach S2, but the first three acknowledgements are lost on the way back.
    const faulty = new FaultyStreams(t.s2());
    faulty.loseAcks = 3;
    const worker = t.worker({ offset: 9, prefix: "acks" });
    await worker.host.start();
    const node = await t.node({ worker, modelProvider: done, streams: faulty });
    await openSession(node);
    await sendMessage(node);
    await until(() => view(node), (v) => v.status === "completed", "completed", 20_000);

    // The relay kept the rows it saw fail; its next append, or the sweep's drain, finds the
    // stream already past them (a conditional append) and deletes them without appending again.
    const history = await completeHistory(node);
    expect(faulty.loseAcks).toBe(0);
    expect(countOf(history, "command.message")).toBe(1);
    expect(countOf(history, "turn.completed")).toBe(1);
    expect(new Set(history.map((event) => event.cursor)).size).toBe(history.length);
  });

  it("§17.7 S2 unavailable: state commits, history is 503, and the stream is complete after S2 returns", async () => {
    const t = failureTenant();
    // The node reaches s2-lite through a proxy the test can take down.
    const proxy = await tcpProxy(Number(new URL(stackEndpoints().s2.endpoint).port));
    t.atEnd(() => proxy.close());
    const worker = t.worker({ offset: 10, prefix: "s2down" });
    await worker.host.start();
    const node = await t.node({ worker, modelProvider: done, streams: t.s2(proxy.endpoint) });
    await openSession(node);
    const observer = sse(node);
    await sendMessage(node, "s1", 1);
    await observer.until("the first turn", (f) => countOf(f, "turn.completed") === 1);

    await proxy.down();
    await sendMessage(node, "s1", 2);
    // The turn runs to completion on Postgres and Restate without S2.
    await until(() => view(node), (v) => v.status === "completed", "the second turn", 20_000);
    const history503 = await fetch(`${node.url}/v1/sessions/s1/items`, { headers: server });
    expect(history503.status).toBe(503);
    const store = await openTestSessionStore(node);
    try {
      const rows = await store.tx((tx) => tx.outbox(1000, { sessionId: "s1" }));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.seq)).toEqual(range(rows[0]!.seq, rows[0]!.seq + rows.length));
    } finally {
      await store.close();
    }
    expect(countOf(observer.frames, "turn.completed")).toBe(1);

    await proxy.up();
    // The sweep drains the outbox in order; the stalled SSE resumes where it stopped.
    const history = await completeHistory(node);
    expect(countOf(history, "command.message")).toBe(2);
    expect(countOf(history, "turn.completed")).toBe(2);
    await observer.until("every event", (f) => f.length >= history.length);
    expect(observer.close()).toEqual(history);
  });

  it("§17.8 an SSE client reconnecting to a different API node resumes without a gap", async () => {
    const t = failureTenant();
    const model = controlledModel();
    t.onDispose(() => model.release());
    const worker = t.worker({ offset: 11, prefix: "sse" });
    await worker.host.start();
    const a = await t.node({ worker, workerId: "worker-a", modelProvider: model.provider });
    const b = await t.node({
      worker: t.worker({ offset: 11, prefix: "sse", role: "api" }),
      workerId: "api-b",
      modelProvider: model.provider,
    });
    await openSession(a);
    await sendMessage(a);
    await model.started;
    await ticks(a, "s1", 10, "a");

    const onA = sse(a);
    await onA.until("ten events on node A", (f) => f.length >= 10);
    const seen = onA.close();

    // Events keep coming from both nodes and the turn while the client is away.
    await ticks(b, "s1", 10, "b");
    const onB = sse(b, seen.at(-1)!.cursor);
    await ticks(a, "s1", 10, "a");
    model.release();
    await until(() => view(b), (v) => v.status === "completed", "completed", 20_000);
    const history = await completeHistory(b);
    await onB.until("the rest of the history on node B", (f) => f.length >= history.length - seen.length);
    const resumed = onB.close();
    expect(seqsOf(seen)).toEqual(range(0, seen.length));
    expect(seqsOf(resumed)).toEqual(range(seen.length, history.length));
    expect([...seen, ...resumed]).toEqual(history);
    expect(countOf(history, "turn.completed")).toBe(1);
  });
});
