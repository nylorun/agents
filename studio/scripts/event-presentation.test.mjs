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
  assert.equal(eventLabel({ type: "tool.completed" }), "Tool completed");
  assert.equal(eventLabel({ type: "turn.completed" }), "Turn completed");
  assert.equal(eventLabel({ type: "effect.uncertain" }), "Effect uncertain");
});

test("labels workflow LiveEvent types", () => {
  assert.equal(eventLabel({ type: "node.started" }), "Node started");
  assert.equal(eventLabel({ type: "loop.iteration" }), "Loop iteration");
  assert.equal(eventLabel({ type: "loop.verified" }), "Loop verified");
  assert.equal(
    eventSummary({
      type: "loop.verified",
      payload: { path: "fix-tests", n: 1, pass: false, feedback: "tests still red" },
    }),
    "fix-tests #1: fail — tests still red",
  );
  assert.equal(
    eventSummary({ type: "loop.verified", payload: { path: "fix-tests", n: 2, pass: true } }),
    "fix-tests #2: pass",
  );
});


test("summarizes each MCP server's outcome", () => {
  assert.equal(eventLabel({ type: "mcp.discovered" }), "MCP servers");
  assert.equal(
    eventSummary({
      type: "mcp.discovered",
      payload: {
        servers: [
          { capabilityId: "mcp", serverName: "docs", outcome: "connected", message: "Connected", tools: 2 },
          { capabilityId: "mcp", serverName: "local", outcome: "failed", message: "connect ECONNREFUSED 127.0.0.1:3002", tools: 0 },
        ],
      },
    }),
    "docs: 2 tools · local failed: connect ECONNREFUSED 127.0.0.1:3002",
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
      type: "tool.completed",
      payload: { toolName: "lookup", output: { ok: true } },
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

test("names delegations and the agent behind child tool calls", () => {
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
      type: "tool.completed",
      payload: { agent, toolName: "search_orders", output: { found: 7 } },
    }),
    'researcher › Tool · search_orders: {"found":7}',
  );
});
