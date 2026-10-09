/**
 * The advance's ownership steps and the Tenant sweep's steps, on a Postgres Tenant schema
 * (architecture §10.5–10.6, §12.3): the wake outbox, orphaned sessions and linked agents.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Wake } from "../../src/execution/types.js";
import { commandKey, linkedMessageKey } from "../../src/core/flow-host.js";
import { isOwnershipLost, ownedTx } from "../../src/store/ownership.js";
import type { SessionStore, Tx } from "../../src/store/types.js";
import { advance } from "../../src/tenant/advance.js";
import type { TenantContext } from "../../src/tenant/context.js";
import { createWorkState } from "../../src/tenant/scheduler.js";
import {
  MAX_WAKE_ATTEMPTS,
  ORPHAN_SCAN_MS,
  WAKE_GRACE_MS,
  deliverPendingWakes,
  reconcileLinkedAgents,
  sweep,
  wakeOrphanedSessions,
} from "../../src/tenant/sweep.js";
import { TenantWorkers } from "../../src/tenant/worker.js";
import { createTestSessionStore, dropTestTenant, testTenantPool } from "../support/store.js";
import { inProcessToolGate } from "../../src/gates/tool-gate.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeStore(): Promise<SessionStore> {
  const store = await createTestSessionStore();
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await dropTestTenant(store.tenantId);
  });
  return store;
}

const silent = { info() {}, warn() {}, error() {} };

/** `accept` decides what the Tenant's `wake` answers: `false` is a closing Tenant's. */
function contextOf(
  store: SessionStore,
  ownerLeaseMs = 1000,
  accept: (id: string, wake: Wake) => boolean = () => true
) {
  const wakes: { id: string; wake: Wake }[] = [];
  const ctx = {
    store,
    closing: false,
    closed: false,
    workerId: "worker-test",
    ownerLeaseMs,
    work: createWorkState(),
    config: { logger: silent },
    toolGate: inProcessToolGate(),
    // What the whole sweep reaches beyond the store: no sandboxes, pods, MCP or hooks.
    sandbox: { sweep: async () => {} },
    sweepHooks: new Set(),
    wake: async (id: string, wake: Wake) => {
      wakes.push({ id, wake });
      return accept(id, wake);
    },
  } as unknown as TenantContext;
  return { ctx, wakes };
}

/** Writes an outbox wake for `id` whose delivery after commit did not happen. */
const undelivered = (store: SessionStore, id: string, wake: Wake) =>
  store.tx((t) => t.wake(id, wake, () => false));
const pending = (store: SessionStore) =>
  store.tx((t) => t.pendingWakes(new Date(Date.now() + 60_000), 100));
/** Every wake outbox row, parked ones too, read directly. */
const outboxRows = (store: SessionStore) =>
  testTenantPool(store.tenantId)`SELECT id, attempts, parked_at FROM nylorun.wakes`;

function session(id: string, fields: Record<string, unknown> = {}) {
  return { id, agentId: "bot", status: "idle", activeTurnId: null, ...fields };
}

function effect(id: string, sessionId: string, turnId: string, status: string) {
  return {
    request: { effectId: id, sessionId, turnId, kind: "model" },
    status,
  };
}

/** A Loop's `agent` effect request for iteration `n` of workflow `wf`, turn `t1`. */
function agentEffect(effectId: string, n: number) {
  return {
    effectId,
    sessionId: "wf",
    turnId: "t1",
    kind: "agent",
    path: "writer",
    iterations: String(n),
    input: { agentId: "writer", input: "go", path: "writer" },
  } as any;
}

/** Commit the message an agent effect sends: its idempotency key opens `agentTurnId`. */
async function commitLinkedMessage(t: Tx, request: any, agentTurnId: string) {
  const key = linkedMessageKey(request);
  await t.put("commands", commandKey("agent", key), {
    command: { type: "message", idempotencyKey: key },
    response: { status: "accepted", turnId: agentTurnId },
  });
}

const eventsOf = async (store: SessionStore, sessionId: string) => {
  const record = store.record();
  const head = (await record.heads(undefined, 1000)).find((h) => h.sessionId === sessionId);
  if (!head) return [];
  return (await record.readRange(head.tenantId, sessionId, 0, head.head)).map(
    (row) => (row.body as { type: string }).type
  );
};

describe("on the Postgres store", () => {
  it("an advance is busy while another owner holds a live lease", async () => {
    const store = await makeStore();
    const { ctx } = contextOf(store, 5000);
    await store.tx(async (t) => {
      await t.put("sessions", "s1", session("s1", { status: "runnable", checkpoint: {} }));
      await t.takeOwnership("s1", {
        owner: "worker-other",
        now: new Date(),
        leaseMs: 2000,
      });
    });
    const result = await advance(ctx, "s1", new AbortController().signal);
    expect(result.status).toBe("busy");
    if (result.status === "busy") {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(25);
      expect(result.retryAfterMs).toBeLessThanOrEqual(2000);
    }
    const stored = await store.tx((t) => t.get("sessions", "s1"));
    expect(stored).toMatchObject({ owner: "worker-other", epoch: 1, status: "runnable" });
  });

  it("takes over from a dead owner: its invoking effects become uncertain", async () => {
    const store = await makeStore();
    const { ctx } = contextOf(store);
    await store.tx(async (t) => {
      await t.put(
        "sessions",
        "s1",
        session("s1", { status: "running", activeTurnId: "t1", checkpoint: {} })
      );
      await t.put("effects", "e1", effect("e1", "s1", "t1", "invoking"));
      await t.put("effects", "e2", effect("e2", "s1", "t1", "completed"));
      // The dead Worker's lease has already lapsed.
      await t.takeOwnership("s1", {
        owner: "worker-dead",
        now: new Date(Date.now() - 60_000),
        leaseMs: 1000,
      });
    });
    expect(await advance(ctx, "s1", new AbortController().signal)).toEqual({
      status: "done",
    });
    const after = await store.tx(async (t) => ({
      session: await t.get("sessions", "s1"),
      e1: await t.get("effects", "e1"),
      e2: await t.get("effects", "e2"),
    }));
    expect(after.e1.status).toBe("uncertain");
    expect(after.e2.status).toBe("completed");
    // Nothing left to run: the advance released ownership in the same transaction.
    expect(after.session).toMatchObject({
      status: "uncertain",
      owner: null,
      epoch: 2,
    });
    expect(await eventsOf(store, "s1")).toEqual(["effect.uncertain"]);
    // A second advance finds nothing to take over.
    await advance(ctx, "s1", new AbortController().signal);
    expect(await eventsOf(store, "s1")).toEqual(["effect.uncertain"]);
  });

  it("takes and releases ownership of a session with nothing to run", async () => {
    const store = await makeStore();
    const { ctx } = contextOf(store);
    await store.tx((t) => t.put("sessions", "s1", session("s1", { status: "waiting" })));
    expect(await advance(ctx, "s1", new AbortController().signal)).toEqual({
      status: "done",
    });
    expect(await advance(ctx, "missing", new AbortController().signal)).toEqual({
      status: "done",
    });
    expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject({
      status: "waiting",
      owner: null,
    });
  });

  it("a stale epoch writes nothing", async () => {
    const store = await makeStore();
    await store.tx((t) => t.put("sessions", "s1", session("s1")));
    const first = await store.tx((t) =>
      t.takeOwnership("s1", { owner: "a", now: new Date(), leaseMs: -1 })
    );
    const second = await store.tx((t) =>
      t.takeOwnership("s1", { owner: "b", now: new Date(), leaseMs: 1000 })
    );
    expect(first.status === "owned" && second.status === "owned").toBe(true);
    const stale = first.status === "owned" ? first.epoch : -1;
    const error = await ownedTx(store, "s1", stale, async (t, s) => {
      await t.put("sessions", "s1", { ...s, status: "failed" });
      await t.event("s1", null, "turn.failed", {});
    }).catch((caught) => caught);
    expect(isOwnershipLost(error)).toBe(true);
    expect(await store.tx((t) => t.get("sessions", "s1"))).toMatchObject({
      status: "idle",
      owner: "b",
    });
    expect(await eventsOf(store, "s1")).toEqual([]);
  });

  it("wakes running or runnable sessions that have no live owner", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store);
    await store.tx(async (t) => {
      await t.put("sessions", "lost-wake", session("lost-wake", { status: "runnable" }));
      await t.put("sessions", "dead-owner", session("dead-owner", { status: "running" }));
      await t.takeOwnership("dead-owner", {
        owner: "worker-dead",
        now: new Date(Date.now() - 60_000),
        leaseMs: 1000,
      });
      await t.put("sessions", "live-owner", session("live-owner", { status: "running" }));
      await t.takeOwnership("live-owner", {
        owner: "worker-live",
        now: new Date(),
        leaseMs: 60_000,
      });
      await t.put("sessions", "waiting", session("waiting", { status: "waiting" }));
    });
    const woken = await wakeOrphanedSessions(ctx);
    expect(woken.sort()).toEqual(["dead-owner", "lost-wake"]);
    expect(wakes.map((w) => w.wake)).toEqual([
      { reason: "recover" },
      { reason: "recover" },
    ]);
  });

  it("delivers the outbox wakes their commits did not, keeping the ones a closing Tenant declines", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store, 1000, (id) => id !== "declined");
    await undelivered(store, "s1", { reason: "message", dedupeKey: "message:t1:0" });
    await undelivered(store, "declined", { reason: "linked", dedupeKey: "linked:t1:e1" });
    await undelivered(store, "s2", { reason: "flow" });
    const [, , flow] = await pending(store);
    // Too young for this pass.
    expect(await deliverPendingWakes(ctx, new Date(Date.now() - 60_000))).toEqual([]);
    expect(wakes).toEqual([]);

    const delivered = await deliverPendingWakes(ctx, new Date(Date.now() + 1000));
    expect(delivered).toHaveLength(2);
    expect(wakes).toEqual([
      { id: "s1", wake: { reason: "message", dedupeKey: "message:t1:0" } },
      { id: "declined", wake: { reason: "linked", dedupeKey: "linked:t1:e1" } },
      // A wake without a dedupe key is sent under one made from its row.
      { id: "s2", wake: { reason: "flow", dedupeKey: `wake:${flow!.id}` } },
    ]);
    expect((await pending(store)).map((row) => row.sessionId)).toEqual(["declined"]);
  });

  it("delivers each wake on its own: one that fails is retried later and holds back none behind it", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store, 1000, (id) => {
      if (id === "poison") throw new Error("Restate ingress 400: refused");
      return true;
    });
    await undelivered(store, "poison", { reason: "message" });
    await undelivered(store, "s1", { reason: "message" });
    await undelivered(store, "s2", { reason: "flow" });
    const delivered = await deliverPendingWakes(ctx, new Date(Date.now() + 1000));
    expect(delivered).toHaveLength(2);
    expect(wakes.map((w) => w.id)).toEqual(["poison", "s1", "s2"]);
    // Counted, and not due again until its retry: the next pass skips it.
    const [left] = await store.tx((t) => t.pendingWakes(new Date(Date.now() + 60_000), 100));
    expect(left).toBeUndefined();
    wakes.length = 0;
    expect(await deliverPendingWakes(ctx, new Date(Date.now() + 1000))).toEqual([]);
    expect(wakes).toEqual([]);
  });

  it("parks a wake after MAX_WAKE_ATTEMPTS failed deliveries, logs it once at error and keeps it", async () => {
    const store = await makeStore();
    const logged: { level: string; message: string; fields: any }[] = [];
    const logger = Object.fromEntries(
      ["info", "warn", "error"].map((level) => [
        level,
        (message: string, fields: unknown) => logged.push({ level, message, fields }),
      ])
    );
    const { ctx } = contextOf(store, 1000, () => {
      throw new Error("Unknown wake reason: later");
    });
    (ctx as any).config = { logger };
    await undelivered(store, "poison", { reason: "message" });
    const [row] = await pending(store);
    // The sweep failed it all but once already; each retry is due at once here.
    for (let i = 1; i < MAX_WAKE_ATTEMPTS; i++)
      await store.tx((t) => t.failWake(row!.id, { retryInMs: 0, park: false }));
    expect((await pending(store))[0]!.attempts).toBe(MAX_WAKE_ATTEMPTS - 1);
    await deliverPendingWakes(ctx, new Date(Date.now() + 1000));
    expect(logged.filter((entry) => entry.level === "error")).toMatchObject([
      {
        message: "wake outbox row parked: its delivery keeps failing",
        fields: { wakeId: row!.id, sessionId: "poison", attempts: MAX_WAKE_ATTEMPTS },
      },
    ]);
    // Parked: never due again, never sent again, but kept.
    expect(await pending(store)).toEqual([]);
    await deliverPendingWakes(ctx, new Date(Date.now() + 1000));
    expect(logged.filter((entry) => entry.level === "error")).toHaveLength(1);
    expect(await outboxRows(store)).toMatchObject([
      { id: row!.id, attempts: MAX_WAKE_ATTEMPTS, parked_at: expect.any(String) },
    ]);
  });

  it("goes on with its other steps, and does not fail, when a wake cannot be delivered", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store, 1000, (_id, wake) => {
      if (wake.reason === "message") throw new Error("Restate ingress 400: refused");
      return true;
    });
    await undelivered(store, "poison", { reason: "message" });
    await store.tx((t) =>
      t.put("sessions", "orphan", session("orphan", { status: "runnable" }))
    );
    await sweep(ctx);
    expect(wakes).toEqual([
      { id: "poison", wake: expect.objectContaining({ reason: "message" }) },
      { id: "orphan", wake: { reason: "recover" } },
    ]);
  });

  it("delivers every outbox wake on its first pass, then only those older than the grace", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store);
    await undelivered(store, "left-by-a-crash", { reason: "message" });
    await sweep(ctx);
    expect(wakes.map((w) => w.id)).toEqual(["left-by-a-crash"]);
    expect(await pending(store)).toEqual([]);

    wakes.length = 0;
    await undelivered(store, "just-committed", { reason: "message" });
    await sweep(ctx);
    expect(wakes).toEqual([]);
    expect((await pending(store)).map((row) => row.sessionId)).toEqual(["just-committed"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + WAKE_GRACE_MS + 1000);
      await sweep(ctx);
    } finally {
      vi.useRealTimers();
    }
    expect(wakes.map((w) => w.id)).toEqual(["just-committed"]);
    expect(await pending(store)).toEqual([]);
  });

  it("scans for orphaned sessions on its first pass, then once per ORPHAN_SCAN_MS", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store);
    await store.tx((t) =>
      t.put("sessions", "orphan", session("orphan", { status: "runnable" }))
    );
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      await sweep(ctx);
      expect(wakes).toEqual([{ id: "orphan", wake: { reason: "recover" } }]);
      vi.setSystemTime(start + ORPHAN_SCAN_MS - 1);
      await sweep(ctx);
      expect(wakes).toHaveLength(1);
      vi.setSystemTime(start + ORPHAN_SCAN_MS);
      await sweep(ctx);
      expect(wakes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    // Another process (a context of its own) scans on its first pass.
    const other = contextOf(store);
    await sweep(other.ctx);
    expect(other.wakes).toEqual([{ id: "orphan", wake: { reason: "recover" } }]);
  });

  it("settles a pending agent effect whose linked turn already finished", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store);
    await store.tx(async (t) => {
      await t.put("sessions", "wf", session("wf", { status: "waiting", activeTurnId: "t1" }));
      await t.put(
        "sessions",
        "agent",
        session("agent", {
          status: "completed",
          lastOutput: "done",
          lastTurnId: "a1",
        })
      );
      await t.put("links", "agent", {
        workflowSessionId: "wf",
        path: "writer",
        effectId: "eff",
        turnId: "t1",
      });
      const request = agentEffect("eff", 1);
      await t.put("effects", "eff", {
        request,
        status: "pending",
        agentSessionId: "agent",
      });
      await commitLinkedMessage(t, request, "a1");
    });
    await reconcileLinkedAgents(ctx);
    expect(await store.tx((t) => t.get("effects", "eff"))).toMatchObject({
      status: "completed",
      outcome: { value: "done" },
    });
    expect(await store.tx((t) => t.get("sessions", "wf"))).toMatchObject({
      status: "runnable",
    });
    expect(wakes).toEqual([
      { id: "wf", wake: { reason: "linked", dedupeKey: "linked:t1:eff" } },
    ]);
    await reconcileLinkedAgents(ctx);
    expect(wakes).toHaveLength(1);
  });

  // The tracer's Postgres flake: the sweep ran between the Loop's iteration-2 `agent` effect
  // commit and its message commit, and settled iteration 2 from iteration 1's turn.
  it("never settles a Loop's next agent effect from the linked session's earlier turn", async () => {
    const store = await makeStore();
    const { ctx, wakes } = contextOf(store);
    const first = agentEffect("eff-1", 1);
    const second = agentEffect("eff-2", 2);
    await store.tx(async (t) => {
      await t.put("sessions", "wf", session("wf", { status: "waiting", activeTurnId: "t1" }));
      // Iteration 1 ended with draft-v1 and settled its effect.
      await commitLinkedMessage(t, first, "a1");
      await t.put(
        "sessions",
        "agent",
        session("agent", {
          status: "completed",
          lastOutput: "draft-v1",
          lastTurnId: "a1",
        })
      );
      await t.put("effects", "eff-1", {
        request: first,
        status: "completed",
        agentSessionId: "agent",
        outcome: { value: "draft-v1" },
      });
      // Iteration 2's effect and link are committed; its message is not yet.
      await t.put("effects", "eff-2", {
        request: second,
        status: "pending",
        agentSessionId: "agent",
      });
      await t.put("links", "agent", {
        workflowSessionId: "wf",
        path: "writer",
        effectId: "eff-2",
        turnId: "t1",
      });
    });
    await reconcileLinkedAgents(ctx);
    expect(await store.tx((t) => t.get("effects", "eff-2"))).toMatchObject({
      status: "pending",
    });
    expect(wakes).toEqual([]);

    // The message commits and opens turn a2: still running, still pending.
    await store.tx(async (t) => {
      const agent = await t.lockSession<any>("agent");
      await t.put("sessions", "agent", {
        ...agent,
        status: "runnable",
        activeTurnId: "a2",
      });
      await commitLinkedMessage(t, second, "a2");
    });
    await reconcileLinkedAgents(ctx);
    expect(await store.tx((t) => t.get("effects", "eff-2"))).toMatchObject({
      status: "pending",
    });
    expect(wakes).toEqual([]);

    // Turn a2 ends (its settle's wake was lost): the sweep settles iteration 2 with draft-v2.
    await store.tx(async (t) => {
      const agent = await t.lockSession<any>("agent");
      await t.put("sessions", "agent", {
        ...agent,
        status: "completed",
        activeTurnId: null,
        lastTurnId: "a2",
        lastOutput: "draft-v2",
      });
    });
    await reconcileLinkedAgents(ctx);
    expect(await store.tx((t) => t.get("effects", "eff-2"))).toMatchObject({
      status: "completed",
      outcome: { value: "draft-v2" },
    });
    expect(wakes).toEqual([
      { id: "wf", wake: { reason: "linked", dedupeKey: "linked:t1:eff-2" } },
    ]);
  });
});

it("dispatches handlers by Tenant and resolves Tenants that are not registered", async () => {
  const calls: string[] = [];
  const worker = (name: string) => ({
    advance: async (sessionId: string) => {
      calls.push(`${name}:advance:${sessionId}`);
      return { status: "done" as const };
    },
    sweep: async () => {
      calls.push(`${name}:sweep`);
    },
  });
  const resolved: string[] = [];
  const workers = new TenantWorkers({
    resolve: async (tenantId) => {
      resolved.push(tenantId);
      return tenantId === "tn_lazy" ? worker("lazy") : undefined;
    },
  });
  const unregister = workers.register("tn_a", worker("a"));
  const signal = new AbortController().signal;
  await workers.handlers.advance("tn_a", "s1", signal);
  await workers.handlers.sweep("tn_a");
  await workers.handlers.advance("tn_lazy", "s2", signal);
  expect(await workers.handlers.advance("tn_gone", "s3", signal)).toEqual({
    status: "done",
  });
  await workers.handlers.sweep("tn_gone");
  // Unregistering only removes the worker that registered.
  workers.register("tn_b", worker("b"));
  unregister();
  expect(workers.get("tn_a")).toBeUndefined();
  expect(workers.get("tn_b")).toBeDefined();
  expect(calls).toEqual(["a:advance:s1", "a:sweep", "lazy:advance:s2"]);
  expect(resolved).toEqual(["tn_lazy", "tn_gone", "tn_gone"]);
});
