/**
 * The advance's ownership steps and the Tenant sweep's steps, on the in-memory Session Store
 * and, with `NYLORUN_TEST_STORE=postgres`, on a Postgres Tenant schema (architecture
 * §10.5–10.6, §12.3).
 */
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type { Action } from "@nylorun/core/contracts";
import type { Wake } from "../../src/execution/types.js";
import { commandKey, linkedMessageKey } from "../../src/core/flow-host.js";
import { MemorySessionStore } from "../../src/store/memory.js";
import { isOwnershipLost, ownedTx } from "../../src/store/ownership.js";
import type { SessionStore, Tx } from "../../src/store/types.js";
import { advance } from "../../src/tenant/advance.js";
import type { TenantContext } from "../../src/tenant/context.js";
import { createWorkState } from "../../src/tenant/scheduler.js";
import { sweepDeliveries } from "../../src/tenant/delivery.js";
import {
  reconcileLinkedAgents,
  wakeOrphanedSessions,
} from "../../src/tenant/sweep.js";
import { TenantWorkers } from "../../src/tenant/worker.js";
import {
  TEST_STORE,
  openTestSessionStore,
  dropTestTenant,
  testCatalog,
  testEnvelope,
} from "../support/store.js";

const TENANT = "tn_sweeptest";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const stores: [string, () => Promise<SessionStore>][] = [
  ["memory", async () => new MemorySessionStore({ tenantId: TENANT })],
];
if (TEST_STORE === "postgres")
  stores.push([
    "postgres",
    async () => {
      const tenantId = newTenantId();
      await testCatalog().createTenant({
        envelope: testEnvelope(tenantId),
        principals: {
          principalId: "principal_sweep",
          credentialHash: "ab".repeat(32),
          idempotencyKey: `boot-${tenantId}`,
        },
      });
      const store = await openTestSessionStore({ root: "", tenantId });
      cleanups.push(async () => {
        await store.close().catch(() => undefined);
        await dropTestTenant(tenantId);
      });
      return store;
    },
  ]);

const silent = { info() {}, warn() {}, error() {} };

function contextOf(store: SessionStore, ownerLeaseMs = 1000) {
  const wakes: { id: string; wake: Wake }[] = [];
  const delivered: string[] = [];
  const ctx = {
    store,
    closing: false,
    closed: false,
    workerId: "worker-test",
    ownerLeaseMs,
    work: createWorkState(),
    config: { logger: silent },
    wake: async (id: string, wake: Wake) => {
      wakes.push({ id, wake });
    },
    deliver: async (actionId: string) => {
      delivered.push(actionId);
    },
  } as unknown as TenantContext;
  return { ctx, wakes, delivered };
}

function session(id: string, fields: Record<string, unknown> = {}) {
  return { id, agentId: "bot", status: "idle", activeTurnId: null, ...fields };
}

function effect(id: string, sessionId: string, turnId: string, status: string) {
  return {
    request: { effectId: id, sessionId, turnId, kind: "model" },
    status,
  };
}

function action(fields: Partial<Action> & Pick<Action, "actionId" | "kind">): Action {
  return {
    sessionId: "s1",
    turnId: "t1",
    agentId: "bot",
    manifestHash: "h",
    implementationVersion: "dev",
    input: {},
    context: {},
    status: "delivering",
    generation: 1,
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
    ...(fields.kind === "tool"
      ? { capabilityId: "notes", toolName: "save" }
      : fields.kind === "hook"
        ? { hook: { at: "before", scope: "step", capabilityIds: ["x"] } }
        : { path: "p", key: "p" }),
    ...fields,
  } as Action;
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

const eventsOf = async (store: SessionStore, sessionId: string) =>
  (await store.tx((t) => t.outbox(100, { sessionId }))).map(
    (row) => row.event.type
  );

describe.each(stores)("on the %s store", (_name, makeStore) => {
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

  it("loses lapsed deliveries by kind and leaves live ones alone", async () => {
    const store = await makeStore();
    const { ctx, delivered } = contextOf(store);
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.tx(async (t) => {
      await t.put("sessions", "s1", session("s1", { status: "waiting", activeTurnId: "t1" }));
      await t.put("actions", "tool-1", action({ actionId: "tool-1", kind: "tool" }));
      await t.put("effects", "tool-1", effect("tool-1", "s1", "t1", "pending"));
      await t.put("actions", "fn-1", action({ actionId: "fn-1", kind: "fn" }));
      await t.put("actions", "hook-1", action({ actionId: "hook-1", kind: "hook" }));
      await t.put(
        "actions",
        "live-1",
        action({ actionId: "live-1", kind: "tool", deadlineAt: future })
      );
    });
    expect(await sweepDeliveries(ctx)).toBe(3);
    const after = await store.tx(async (t) => ({
      session: await t.get("sessions", "s1"),
      tool: await t.get<Action>("actions", "tool-1"),
      toolEffect: await t.get("effects", "tool-1"),
      fn: await t.get<Action>("actions", "fn-1"),
      hook: await t.get<Action>("actions", "hook-1"),
      live: await t.get<Action>("actions", "live-1"),
    }));
    // A lost tool delivery is uncertain; a hook or fn goes back to pending and is sent again.
    expect(after.tool?.status).toBe("uncertain");
    expect(after.toolEffect.status).toBe("uncertain");
    expect(after.session.status).toBe("uncertain");
    expect(after.fn).toMatchObject({ status: "pending", deadlineAt: null });
    expect(after.hook).toMatchObject({ status: "pending", deadlineAt: null });
    expect(after.live?.status).toBe("delivering");
    expect(delivered.sort()).toEqual(["fn-1", "hook-1"]);
    expect(await eventsOf(store, "s1")).toEqual(["action.uncertain"]);
    expect(await sweepDeliveries(ctx)).toBe(0);
  });

  it("sends pending Actions again only for agents with an endpoint", async () => {
    const store = await makeStore();
    const { ctx, delivered } = contextOf(store);
    await store.tx(async (t) => {
      await t.put("sessions", "s1", session("s1", { status: "waiting", activeTurnId: "t1" }));
      await t.putEndpoint({
        agentId: "bot",
        url: "http://127.0.0.1:1/actions",
        implementationVersion: "dev",
        timeoutMs: 60_000,
        maxConcurrent: 16,
        updatedAt: new Date().toISOString(),
      });
      await t.put("actions", "v1", action({ actionId: "v1", kind: "verify", status: "pending", deadlineAt: null }));
      await t.put(
        "actions",
        "other-1",
        action({ actionId: "other-1", kind: "tool", agentId: "other", status: "pending", deadlineAt: null })
      );
    });
    expect(await sweepDeliveries(ctx)).toBe(0);
    expect(delivered).toEqual(["v1"]);
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
