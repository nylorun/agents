import assert from "node:assert/strict";
import test from "node:test";
import {
  eventLabel,
  eventSummary,
  mergeStudioEvents,
  pluginLabel,
  toolTrace,
  toolTraceText,
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
          { serverName: "docs", outcome: "connected", message: "Connected", tools: 2 },
          { serverName: "local", outcome: "failed", message: "connect ECONNREFUSED 127.0.0.1:3002", tools: 0 },
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

test("summarizes a message with parts as its text and a count of its files", () => {
  const parts = (...items) => ({ type: "command.message", payload: { type: "message", parts: items } });
  const file = (artifactId) => ({ type: "file", artifactId, version: 1 });
  assert.equal(
    eventSummary(parts({ type: "text", text: "Compare" }, file("a"), { type: "text", text: "these" }, file("b"))),
    "Compare these · 2 files",
  );
  assert.equal(eventSummary(parts({ type: "text", text: "Read this" }, file("a"))), "Read this · 1 file");
  assert.equal(eventSummary(parts(file("a"))), "1 file");
  assert.equal(eventSummary(parts({ type: "text", text: "Just text" })), "Just text");
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

test("traces a tool call to its server or skill and the plugin that brought it", () => {
  const plugin = { name: "acme-tools", version: "1.2.0" };
  assert.deepEqual(toolTrace({ toolName: "search", kind: "mcp", server: "docs", plugin }), {
    kind: "MCP",
    server: "docs",
    plugin,
  });
  assert.equal(
    eventSummary({
      type: "tool.completed",
      payload: { toolName: "search", kind: "mcp", server: "docs", plugin, output: { hits: 2 } },
    }),
    'Tool · search (MCP docs, plugin acme-tools 1.2.0): {"hits":2}',
  );
  assert.equal(
    eventSummary({
      type: "tool.completed",
      payload: { toolName: "bash", kind: "sandbox", skill: "pdf", plugin: { name: "office" }, output: "ok" },
    }),
    "Tool · bash (Sandbox, skill pdf, plugin office): ok",
  );
  assert.equal(
    toolTraceText(toolTrace({ toolName: "load_skill", kind: "harness", skill: "pdf" })),
    "Harness, skill pdf",
  );
  assert.equal(
    toolTraceText(toolTrace({ toolName: "fetch", kind: "http", server: "api.example.com" })),
    "HTTP api.example.com",
  );
});

test("names a harness's own tool and reads tool call rows' nulls as absent", () => {
  assert.equal(
    eventSummary({ type: "tool.completed", payload: { toolName: "web_fetch", kind: "harness", output: "page" } }),
    "Tool · web_fetch (Harness): page",
  );
  assert.deepEqual(
    toolTrace({ toolName: "lookup", kind: null, server: null, skill: null, plugin: null }),
    {},
  );
  assert.equal(
    eventSummary({ type: "tool.completed", payload: { toolName: "lookup", output: 1 } }),
    "Tool · lookup: 1",
  );
  assert.equal(pluginLabel(null), undefined);
  assert.equal(pluginLabel({ version: "1.0.0" }), undefined);
  assert.deepEqual(pluginLabel({ name: "office", version: 3 }), { name: "office" });
});

test("names the plugin that brought each discovered MCP server", () => {
  assert.equal(
    eventSummary({
      type: "mcp.discovered",
      payload: {
        servers: [
          { serverName: "docs", plugin: { name: "acme-tools", version: "1.2.0" }, outcome: "connected", message: "Connected", tools: 1 },
          { serverName: "own", outcome: "connected", message: "Connected", tools: 3 },
        ],
      },
    }),
    "docs (plugin acme-tools 1.2.0): 1 tool · own: 3 tools",
  );
});
