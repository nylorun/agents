import assert from "node:assert/strict";
import test from "node:test";
import {
  eventLabel,
  eventSummary,
  mergeStudioEvents,
} from "../web/src/event-presentation.ts";

const base = {
  eventId: "e1",
  sessionId: "s1",
  turnId: "t1",
  cursor: "c1",
  time: "2026-09-21T00:00:00.000Z",
};

test("labels new Runtime LiveEvent types", () => {
  assert.equal(eventLabel({ type: "command.message" }), "Message");
  assert.equal(eventLabel({ type: "action.pending" }), "Action pending");
  assert.equal(eventLabel({ type: "turn.completed" }), "Turn completed");
  assert.equal(eventLabel({ type: "effect.uncertain" }), "Effect uncertain");
});

test("labels workflow LiveEvent types", () => {
  assert.equal(eventLabel({ type: "node.started" }), "Node started");
  assert.equal(eventLabel({ type: "loop.iteration" }), "Loop iteration");
  assert.equal(eventLabel({ type: "loop.decided" }), "Loop decided");
  assert.equal(
    eventSummary({
      type: "loop.decided",
      payload: { path: "fix-tests", n: 1, next: "input", patched: true },
    }),
    "fix-tests #1 → input (patched)",
  );
});


test("summarizes message and action payloads", () => {
  assert.equal(
    eventSummary({
      type: "command.message",
      payload: { content: "Look up order demo-123" },
    }),
    "Look up order demo-123",
  );
  assert.match(
    eventSummary({
      type: "action.completed",
      payload: { toolName: "lookup", result: { ok: true } },
    }),
    /lookup/,
  );
});

test("mergeStudioEvents prefers committed and keeps newest first", () => {
  const older = {
    ...base,
    eventId: "a",
    cursor: "1",
    time: "2026-09-21T00:00:01.000Z",
    type: "command.message",
    payload: {},
    committed: false,
  };
  const newer = {
    ...base,
    eventId: "b",
    cursor: "2",
    time: "2026-09-21T00:00:02.000Z",
    type: "turn.completed",
    payload: { output: "hi" },
    committed: true,
  };
  const merged = mergeStudioEvents(
    [older],
    [
      { ...older, committed: true },
      newer,
    ],
  );
  assert.equal(merged[0]?.eventId, "b");
  assert.equal(merged.find((e) => e.eventId === "a")?.committed, true);
});

test("names delegations and the agent behind child actions", () => {
  const agent = { id: "researcher", path: "support/researcher", delegationId: "d1" };
  assert.equal(eventLabel({ type: "delegation.started" }), "Delegation started");
  assert.equal(
    eventSummary({ type: "delegation.started", payload: { agent, task: "Find order 7" } }),
    "researcher: Find order 7",
  );
  assert.equal(
    eventSummary({
      type: "delegation.completed",
      payload: { agent, status: "completed", outcome: { kind: "completed", output: "Shipped" } },
    }),
    "researcher completed: Shipped",
  );
  assert.equal(
    eventSummary({
      type: "action.pending",
      payload: { agent, toolName: "search_orders", input: { query: "7" } },
    }),
    'researcher › Tool · search_orders: {"query":"7"}',
  );
});

test("labels and summarizes Action endpoint deliveries", () => {
  assert.equal(eventLabel({ type: "action.delivered" }), "Action delivered");
  assert.equal(eventLabel({ type: "action.delivery_failed" }), "Delivery failed");
  assert.equal(
    eventSummary({
      type: "action.delivery_failed",
      payload: {
        actionId: "a1",
        generation: 1,
        reason: "endpoint.unreachable",
        message: "connect ECONNREFUSED 127.0.0.1:3000",
        retryInMs: 4000,
      },
    }),
    "connect ECONNREFUSED 127.0.0.1:3000 (retrying in 4 s)",
  );
  assert.equal(
    eventSummary({ type: "action.delivery_failed", payload: { reason: "endpoint.busy", retryInMs: 250 } }),
    "endpoint.busy (retrying in 1 s)",
  );
});
