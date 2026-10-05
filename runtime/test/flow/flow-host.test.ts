import { expect, it } from "vitest";
import type { HostEffect } from "@nylorun/harness/run";
import {
  aggregateWaits,
  cancelSiblingWork,
  commandKey,
  countActiveFlowWork,
  deriveAgentEffectSessionId,
  deriveSessionId,
  cancelQueuedEffects,
  foreignInteractionConflict,
  linkedMessageInput,
  linkedMessageKey,
  pathDepth,
  planCancelCascade,
  pendingAgentEffects,
  reconcilePendingAgentEffect,
  wakeForQueuedEffects,
  wakeLinkedWorkflow,
  type FlowHostSession,
  type FlowLink,
} from "../../src/core/flow-host.js";
import { resolveFlowLimits } from "../../src/core/limits.js";
import type { DocTable, SessionStore } from "../../src/store/types.js";
import { createTestSessionStore } from "../support/store.js";

async function testStore() {
  const store = await createTestSessionStore();
  return {
    store,
    put: (table: DocTable, id: string, body: unknown) =>
      store.tx((t) => t.put(table, id, body)),
    get: <T = any>(table: DocTable, id: string) =>
      store.tx((t) => t.get<T>(table, id)),
  };
}

/** A flow `agent` effect request of workflow `wf-1`, turn `turn-1`. */
function agentRequest(effectId: string, path: string, iterations = "1") {
  return {
    effectId,
    kind: "agent",
    sessionId: "wf-1",
    turnId: "turn-1",
    path,
    iterations,
    input: { agentId: "writer", input: "go", path },
  } as unknown as HostEffect;
}

/** Commit the message an agent effect sends: its idempotency key opens `agentTurnId`. */
async function commitLinkedMessage(
  put: (table: DocTable, id: string, body: unknown) => Promise<void>,
  agentId: string,
  request: HostEffect,
  agentTurnId: string
) {
  await put("commands", commandKey(agentId, linkedMessageKey(request)), {
    command: { type: "message", idempotencyKey: linkedMessageKey(request) },
    response: { status: "accepted", turnId: agentTurnId },
  });
}

it("WF-R22: deriveSessionId is stable for (workflowSessionId, path)", () => {
  const a = deriveSessionId("wf-1", "review/security");
  const b = deriveSessionId("wf-1", "review/security");
  const c = deriveSessionId("wf-1", "review/style");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a.startsWith("wf_")).toBe(true);
});

it("LOOP-R28/R6: verify-agent sessions differ across Loop iterations", () => {
  const path = "polish/judge";
  const iter1 = deriveAgentEffectSessionId("wf-1", path, {
    turnId: "turn-1",
    iterations: "1",
    context: { role: "verify-agent" },
  });
  const iter2 = deriveAgentEffectSessionId("wf-1", path, {
    turnId: "turn-1",
    iterations: "2",
    context: { role: "verify-agent" },
  });
  const runAgent = deriveAgentEffectSessionId("wf-1", path, {
    turnId: "turn-1",
    iterations: "1",
    context: {},
  });
  expect(iter1).not.toBe(iter2);
  expect(iter1).not.toBe(runAgent);
  expect(iter1).toBe(deriveSessionId("wf-1", path, "verify", "turn-1", "1"));
  expect(iter2).toBe(deriveSessionId("wf-1", path, "verify", "turn-1", "2"));
});

it("PAR-R6/A2: cancelSiblingWork with cancelEffectIds cancels pending siblings", async () => {
  const { store, put, get } = await testStore();
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "running",
    activeTurnId: "turn-1",
  });
  const styleId = deriveSessionId("wf-1", "review/style");
  const testsId = deriveSessionId("wf-1", "review/tests");
  await put("sessions", styleId, {
    id: styleId,
    status: "completed",
    activeTurnId: null,
  });
  await put("sessions", testsId, {
    id: testsId,
    status: "running",
    activeTurnId: "at-tests",
  });
  await put("links", styleId, {
    workflowSessionId: "wf-1",
    path: "review/style",
    effectId: "e-style",
    turnId: "turn-1",
  } satisfies FlowLink);
  await put("links", testsId, {
    workflowSessionId: "wf-1",
    path: "review/tests",
    effectId: "e-tests",
    turnId: "turn-1",
  } satisfies FlowLink);
  await put("effects", "e-tests", {
    request: {
      effectId: "e-tests",
      sessionId: "wf-1",
      turnId: "turn-1",
      path: "review/tests",
      kind: "agent",
    },
    status: "pending",
    agentSessionId: testsId,
  });

  const result = await store.tx((t) =>
    cancelSiblingWork({
      t,
      workflowSessionId: "wf-1",
      turnId: "turn-1",
      cancelEffectIds: ["e-tests"],
    })
  );
  expect(result.agentSessionIds).toContain(testsId);
  expect(result.agentSessionIds).not.toContain(styleId);
  expect((await get("effects", "e-tests"))?.status).toBe("cancelled");
});

it("WF-L1 / PAR-A4: countActiveFlowWork counts running agents and tool nodes in flight of the turn", async () => {
  const { store, put } = await testStore();
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "running",
    activeTurnId: "turn-1",
  });
  const effect = (effectId: string, kind: string, status: string, turnId = "turn-1") => ({
    request: {
      effectId,
      sessionId: "wf-1",
      turnId,
      kind,
      path: `p/${effectId}`,
      key: `p/${effectId}`,
    },
    status,
  });
  // Counted: a pending agent effect, and a tool node effect being invoked.
  await put("effects", "agent-1", effect("agent-1", "agent", "pending"));
  await put("effects", "tool-1", effect("tool-1", "tool", "invoking"));
  // Not counted: queued, completed, uncertain, another turn.
  await put("effects", "tool-2", effect("tool-2", "tool", "queued"));
  await put("effects", "tool-3", effect("tool-3", "tool", "completed"));
  await put("effects", "tool-4", effect("tool-4", "tool", "uncertain"));
  await put("effects", "agent-2", effect("agent-2", "agent", "pending", "turn-0"));

  expect(await store.tx((t) => countActiveFlowWork(t, "wf-1", "turn-1"))).toBe(2);
});

it("WF-L1: wakeForQueuedEffects schedules the workflow after commit when a slot frees", async () => {
  const { store, put, get } = await testStore();
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "turn-1",
  });
  await put("effects", "q", {
    request: { effectId: "q", sessionId: "wf-1", turnId: "turn-1", kind: "tool" },
    status: "queued",
  });
  const scheduled: string[] = [];
  const woke = await store.tx(async (t) => {
    const result = await wakeForQueuedEffects({
      t,
      workflowSessionId: "wf-1",
      turnId: "turn-1",
      limits: resolveFlowLimits({ flow: { maxConcurrency: 1 } }),
      schedule: (sid) => scheduled.push(sid),
    });
    expect(scheduled).toEqual([]);
    return result;
  });
  expect(woke).toBe(true);
  expect(scheduled).toEqual(["wf-1"]);
  expect((await get<FlowHostSession>("sessions", "wf-1"))?.status).toBe(
    "runnable"
  );
});

it("PAR-R6: cancelSiblingWork lists the sibling agents to cancel", async () => {
  const { store, put, get } = await testStore();
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "running",
    activeTurnId: "turn-1",
  });
  const agentId = deriveSessionId("wf-1", "review/style");
  await put("sessions", agentId, {
    id: agentId,
    status: "running",
    activeTurnId: "at-1",
  });
  await put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "review/style",
    effectId: "e-style",
    turnId: "turn-1",
  } satisfies FlowLink);

  const result = await store.tx((t) =>
    cancelSiblingWork({
      t,
      workflowSessionId: "wf-1",
      turnId: "turn-1",
      siblingPaths: ["review/style", "review/tests"],
    })
  );
  expect(result.agentSessionIds).toEqual([agentId]);
});

it("WF-R53 / SD-P11: planCancelCascade orders agents deepest-first", async () => {
  const { store, put } = await testStore();
  await put("sessions", "wf-1", { id: "wf-1" });
  const shallow = deriveSessionId("wf-1", "a");
  const deep = deriveSessionId("wf-1", "a/b/c");
  await put("sessions", shallow, { id: shallow });
  await put("sessions", deep, { id: deep });
  await put("links", shallow, {
    workflowSessionId: "wf-1",
    path: "a",
    effectId: "e1",
    turnId: "t",
  });
  await put("links", deep, {
    workflowSessionId: "wf-1",
    path: "a/b/c",
    effectId: "e2",
    turnId: "t",
  });
  expect(pathDepth("a/b/c")).toBe(3);
  const plan = await store.tx((t) =>
    planCancelCascade({ t, workflowSessionId: "wf-1", turnId: "t" })
  );
  expect(plan.agentSessionIds).toEqual([deep, shallow]);
});

it("WF-R53: cancelQueuedEffects cancels the turn's queued effects only", async () => {
  const { store, put, get } = await testStore();
  await put("sessions", "wf-1", { id: "wf-1" });
  await put("effects", "p", {
    status: "pending",
    request: { effectId: "p", sessionId: "wf-1", turnId: "t" },
  });
  await put("effects", "q", {
    status: "queued",
    request: { effectId: "q", sessionId: "wf-1", turnId: "t" },
  });
  const cancelled = await store.tx((t) =>
    cancelQueuedEffects({ t, workflowSessionId: "wf-1", turnId: "t" })
  );
  expect(cancelled).toEqual(["q"]);
  expect((await get("effects", "q"))?.status).toBe("cancelled");
  expect((await get("effects", "p"))?.status).toBe("pending");
});

it("WF-R51: aggregateWaits lists linked agent interactions with owning session and path", async () => {
  const { store, put } = await testStore();
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
  });
  const agentId = deriveSessionId("wf-1", "polish/writer");
  await put("sessions", agentId, {
    id: agentId,
    status: "paused",
    waits: [
      {
        invocationId: "inv-1",
        interaction: { id: "int-1", kind: "approval" },
        status: "interaction",
      },
    ],
  });
  await put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "polish/writer",
    effectId: "e",
    turnId: "t",
  });
  const waits = await store.tx((t) =>
    aggregateWaits({ t, workflowSessionId: "wf-1" })
  );
  expect(waits).toEqual([
    expect.objectContaining({
      sessionId: agentId,
      path: "polish/writer",
      interactionId: "int-1",
      kind: "approval",
    }),
  ]);
});

it("WF-R52 / LOOP-A4: foreignInteractionConflict returns 409 naming owner session", async () => {
  const { store, put } = await testStore();
  const agentId = deriveSessionId("wf-1", "polish/writer");
  await put("sessions", "wf-1", { id: "wf-1", status: "paused", waits: [] });
  await put("sessions", agentId, {
    id: agentId,
    status: "paused",
    waits: [{ interaction: { id: "int-9", kind: "approval" } }],
  });
  await put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "polish/writer",
    effectId: "e",
    turnId: "t",
  });
  const conflict = await store.tx((t) =>
    foreignInteractionConflict({
      t,
      workflowSessionId: "wf-1",
      interactionId: "int-9",
    })
  );
  expect(conflict).toEqual({
    status: 409,
    message: `Interaction belongs to session ${agentId}`,
    ownerSessionId: agentId,
  });
});

it("D12: a stage's message carries the flow's input as the original request", () => {
  expect(linkedMessageInput({ input: "draft" })).toBe("draft");
  expect(linkedMessageInput({ input: { x: 1 } })).toEqual({ x: 1 });
  expect(linkedMessageInput({ input: "draft", flowInput: "Write about tides." })).toBe(
    "Original request:\nWrite about tides.\n\ndraft"
  );
  const composed = linkedMessageInput({
    input: { task: "t", response: "r", iteration: 1 },
    flowInput: { topic: "tides" },
  });
  expect(composed).toBe(
    'Original request:\n{\n  "topic": "tides"\n}\n\n{\n  "task": "t",\n  "response": "r",\n  "iteration": 1\n}'
  );
  // Deterministic: a replayed effect sends the same message.
  expect(linkedMessageInput({ input: "draft", flowInput: "w" })).toBe(
    linkedMessageInput({ input: "draft", flowInput: "w" })
  );
});

const eventsOf = async (store: SessionStore, sessionId: string) => {
  const record = store.record();
  const head = (await record.heads(undefined, 1000)).find((h) => h.sessionId === sessionId);
  if (!head) return [];
  return (await record.readRange(head.tenantId, sessionId, 0, head.head)).map((row) => {
    const { type, payload } = row.body as { type: string; payload: unknown };
    return { type, payload };
  });
};

it("records a verifier agent's verdict as loop.verified when its turn settles", async () => {
  const { store, put, get } = await testStore();
  await put("sessions", "wf-1", { id: "wf-1", status: "waiting", activeTurnId: "turn-1" });
  const settle = async (path: string, effectId: string, output: unknown, context: object) => {
    const agentId = deriveSessionId("wf-1", path, effectId);
    await put("links", agentId, { workflowSessionId: "wf-1", path, effectId, turnId: "turn-1" });
    const request = { ...agentRequest(effectId, path), context } as HostEffect;
    await put("effects", effectId, { status: "pending", request });
    await commitLinkedMessage(put, agentId, request, `turn-${effectId}`);
    await store.tx((t) =>
      wakeLinkedWorkflow({
        t,
        agentSessionId: agentId,
        turnId: `turn-${effectId}`,
        output: output as never,
        schedule: () => undefined,
      })
    );
  };
  const judged = { loopPath: "fix", role: "verify-agent" };
  await settle("judge", "v-1", { pass: false, feedback: "red" }, { ...judged, n: 1 });
  await settle("judge", "v-2", { pass: true, data: { score: 9 } }, { ...judged, n: 2 });
  // A body turn and a verifier that returned no verdict record nothing.
  await settle("fixer", "b-1", { pass: true }, { loopPath: "fix", n: 1 });
  await settle("judge", "v-3", { score: 1 }, { ...judged, n: 3 });
  expect((await get("effects", "v-1"))?.status).toBe("completed");
  expect((await eventsOf(store, "wf-1")).filter((e) => e.type === "loop.verified")).toEqual([
    { type: "loop.verified", payload: { path: "fix", n: 1, pass: false, feedback: "red" } },
    { type: "loop.verified", payload: { path: "fix", n: 2, pass: true, data: { score: 9 } } },
  ]);
});

it("WF-R54: wakeLinkedWorkflow records agent.cancelled", async () => {
  const { store, put, get } = await testStore();
  const agentId = deriveSessionId("wf-1", "branch");
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "turn-1",
  });
  await put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "branch",
    effectId: "eff-1",
    turnId: "turn-1",
  });
  const request = agentRequest("eff-1", "branch");
  await put("effects", "eff-1", { status: "pending", request });
  await commitLinkedMessage(put, agentId, request, "agent-turn-1");
  let scheduled = "";
  await store.tx((t) =>
    wakeLinkedWorkflow({
      t,
      agentSessionId: agentId,
      turnId: "agent-turn-1",
      cancelled: true,
      schedule: (sid) => {
        scheduled = sid;
      },
    })
  );
  expect((await get("effects", "eff-1"))?.outcome?.value).toMatchObject({
    kind: "failed",
    code: "agent.cancelled",
  });
  expect((await get<FlowHostSession>("sessions", "wf-1"))?.status).toBe(
    "runnable"
  );
  expect(scheduled).toBe("wf-1");
});

it("wakeLinkedWorkflow schedules nothing when the transaction rolls back", async () => {
  const { store, put, get } = await testStore();
  const agentId = deriveSessionId("wf-1", "branch");
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "turn-1",
  });
  await put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "branch",
    effectId: "eff-1",
    turnId: "turn-1",
  });
  const request = agentRequest("eff-1", "branch");
  await put("effects", "eff-1", { status: "pending", request });
  await commitLinkedMessage(put, agentId, request, "agent-turn-1");
  const scheduled: string[] = [];
  await expect(
    store.tx(async (t) => {
      await wakeLinkedWorkflow({
        t,
        agentSessionId: agentId,
        turnId: "agent-turn-1",
        output: "done",
        schedule: (sid) => scheduled.push(sid),
      });
      throw new Error("rollback");
    })
  ).rejects.toThrow("rollback");
  expect(scheduled).toEqual([]);
  expect((await get("effects", "eff-1"))?.status).toBe("pending");
});

it("WF-C9: reconcilePendingAgentEffect wakes on settled linked turns", async () => {
  const { store, put, get } = await testStore();
  const agentId = deriveSessionId("wf-1", "writer");
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "turn-1",
  });
  await put("sessions", agentId, {
    id: agentId,
    status: "completed",
    lastOutput: "done",
    lastTurnId: "agent-turn-1",
    activeTurnId: null,
  });
  await put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "writer",
    effectId: "eff",
    turnId: "turn-1",
  });
  const request = agentRequest("eff", "writer");
  await put("effects", "eff", {
    status: "pending",
    agentSessionId: agentId,
    request,
  });
  await commitLinkedMessage(put, agentId, request, "agent-turn-1");
  const scheduled: { id: string; reason: string }[] = [];
  const pending = await store.tx((t) => pendingAgentEffects(t));
  expect(pending.map((e) => e.request.effectId ?? "eff")).toHaveLength(1);
  expect(
    await store.tx((t) =>
      reconcilePendingAgentEffect({
        t,
        effectId: "eff",
        schedule: (id, wake) => {
          scheduled.push({ id, reason: wake.reason });
        },
      })
    )
  ).toBe(true);
  const effect = await get("effects", "eff");
  expect(effect?.status).toBe("completed");
  expect(effect?.outcome).toEqual({ value: "done" });
  expect(scheduled).toEqual([{ id: "wf-1", reason: "linked" }]);
});

it("an agent effect settles only from the linked turn it started, never an earlier one", async () => {
  const { store, put, get } = await testStore();
  const agentId = deriveSessionId("wf-1", "writer");
  await put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "turn-1",
  });
  // Iteration 1 ended; iteration 2's effect and link are journaled, its message is not.
  const first = agentRequest("eff-1", "writer", "1");
  const second = agentRequest("eff-2", "writer", "2");
  await commitLinkedMessage(put, agentId, first, "agent-turn-1");
  await put("sessions", agentId, {
    id: agentId,
    status: "completed",
    lastOutput: "draft-v1",
    lastTurnId: "agent-turn-1",
    activeTurnId: null,
  });
  await put("effects", "eff-1", {
    status: "completed",
    agentSessionId: agentId,
    request: first,
    outcome: { value: "draft-v1" },
  });
  await put("effects", "eff-2", {
    status: "pending",
    agentSessionId: agentId,
    request: second,
  });
  await put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "writer",
    effectId: "eff-2",
    turnId: "turn-1",
  });
  const scheduled: string[] = [];
  const schedule = (id: string) => {
    scheduled.push(id);
  };

  // Neither the sweep nor a late settle of the earlier turn settles iteration 2.
  expect(
    await store.tx((t) =>
      reconcilePendingAgentEffect({ t, effectId: "eff-2", schedule })
    )
  ).toBe(false);
  await store.tx((t) =>
    wakeLinkedWorkflow({
      t,
      agentSessionId: agentId,
      turnId: "agent-turn-1",
      output: "draft-v1",
      schedule,
    })
  );
  expect((await get("effects", "eff-2"))?.status).toBe("pending");
  expect(scheduled).toEqual([]);

  // Iteration 2's turn ends: its settle completes the effect with its own output.
  await commitLinkedMessage(put, agentId, second, "agent-turn-2");
  await store.tx((t) =>
    wakeLinkedWorkflow({
      t,
      agentSessionId: agentId,
      turnId: "agent-turn-2",
      output: "draft-v2",
      schedule,
    })
  );
  expect(await get("effects", "eff-2")).toMatchObject({
    status: "completed",
    outcome: { value: "draft-v2" },
  });
  expect(scheduled).toEqual(["wf-1"]);
});
