/**
 * The gates' metrics (ADR-159), read in memory: a model call through the meter, a remote MCP
 * request through the gate's handler (with its client span when spans export), an HTTP tool's
 * request, and core's turn
 * and queue points from what commits. The egress counters are tested with egress-gate itself
 * (`test/gates/egress-gate.test.ts`).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { Agent } from "@nylorun/agents";
import { newTenantId } from "@nylorun/core/compatibility";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import { callHttpTarget } from "../../src/gates/http-tool.js";
import { createMeter } from "../../src/gates/meter.js";
import { createMcpHandler } from "../../src/gates/mcp-handler.js";
import type { ModelGateOutcome, ModelGateRequest } from "../../src/gates/model-gate.js";
import type { TenantVaults } from "../../src/gates/tenant-vaults.js";
import { McpCallFailed, type LiveConnection } from "../../src/mcp/connect.js";
import { failure } from "../../src/model/classify.js";
import { recordQueueWaits, recordTurnEnds } from "../../src/telemetry/core.js";
import { noLimitsStore } from "../support/limits.js";
import { createTestSessionStore } from "../support/store.js";
import { countOf, startTestTelemetry, type TestTelemetry } from "../support/telemetry.js";

const quiet = { info() {}, warn() {}, error() {} };

let test: TestTelemetry | undefined;
afterEach(async () => {
  await test?.close();
  test = undefined;
});

const request: ModelGateRequest = {
  tenantId: newTenantId(),
  sessionId: "s1",
  turnId: "turn-1",
  agentId: "bot",
  effectId: "turn-1:0:model:1",
  invocationId: "1",
  call: { executionId: "e", tools: [], prompt: [], model: { id: "openai/gpt-test" } },
};

const answered: ModelGateOutcome = {
  output: [{ type: "text", text: "hi" }],
  finishReason: "stop",
  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.002 },
  evidence: { extras: { producer: { provider: "openai", model: "gpt-test" }, firstTokenMs: 250 } },
};

describe("a model call's metrics", () => {
  it("records its duration, its tokens and its first chunk, by provider and requested model", async () => {
    test = startTestTelemetry();
    const store = await createTestSessionStore();
    const meter = createMeter({ logger: quiet });
    await meter.call(store, { ...request, effectId: "turn-1:0:model:a" }, async () => answered);
    const attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "openai/gpt-test",
    };
    const [duration] = await test.points("gen_ai.client.inference.duration");
    expect(duration!.attributes).toEqual(attributes);
    expect(countOf(duration)).toBe(1);
    expect(await test.points("gen_ai.client.inference.usage.input_tokens")).toEqual([{ attributes, value: 12 }]);
    expect(await test.points("gen_ai.client.inference.usage.output_tokens")).toEqual([{ attributes, value: 3 }]);
    const [first] = await test.points("gen_ai.client.inference.time_to_first_chunk");
    expect(first!.value).toMatchObject({ count: 1, sum: 0.25 });
  });

  it("labels a failed call with its code, and one that threw as aborted, with no tokens", async () => {
    test = startTestTelemetry();
    const store = await createTestSessionStore();
    const meter = createMeter({ logger: quiet });
    await meter.call(store, { ...request, effectId: "turn-1:0:model:b" }, async () => failure("rate_limited", "429", true));
    await expect(
      meter.call(store, { ...request, effectId: "turn-1:0:model:c" }, async () => {
        throw new Error("aborted");
      }),
    ).rejects.toThrow("aborted");
    const errors = (await test.points("gen_ai.client.inference.duration")).map((point) => point.attributes["error.type"]);
    expect(errors.sort()).toEqual(["aborted", "rate_limited"]);
    // The provider from the requested model's id when the call has no producer.
    expect((await test.points("gen_ai.client.inference.duration"))[0]!.attributes["gen_ai.provider.name"]).toBe("openai");
    expect(await test.points("gen_ai.client.inference.usage.input_tokens")).toEqual([]);
  });
});

describe("a remote MCP request's metrics", () => {
  const manifest = Agent({ id: "bot" }).mcp({ remote: { type: "streamable-http", url: "https://mcp.test/mcp" } }).build().manifest;
  const vaults: TenantVaults = {
    open: async () =>
      ({
        tenantId: newTenantId(),
        store: noLimitsStore,
        session: async (id: string) => ({ id, manifest }),
        authorizeMcp: async (_session: string, { url }: { url: string }) => ({ status: "unauthenticated", url, headers: {} }),
      }) as never,
  };
  /** A server whose `search` answers and whose `broken` fails. */
  const open = async (): Promise<LiveConnection> =>
    ({
      client: {
        listTools: async () => ({ tools: [] }),
        callTool: async ({ name }: { name: string }) => {
          if (name === "broken")
            throw new McpCallFailed({ code: "mcp.error", message: "the tool failed", sent: true, retryable: false });
          return { result: { content: [{ type: "text", text: "found" }] } };
        },
      },
      close: async () => {},
    }) as never;
  const server = { sessionId: "s1", serverName: "remote" };
  const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("records each request's duration by method and tool, a failure with its code", async () => {
    test = startTestTelemetry();
    const handler = createMcpHandler({ vaults, logger: quiet as never, open });
    const signal = new AbortController().signal;
    expect((await handler.call(undefined, { server, effectId: "e1", name: "search", arguments: {} }, signal)).ok).toBe(true);
    expect((await handler.call(undefined, { server, effectId: "e2", name: "broken", arguments: {} }, signal)).ok).toBe(false);
    await handler.list(undefined, server, undefined, signal);
    const points = (await test.points("mcp.client.operation.duration")).map((point) => [point.attributes, countOf(point)]);
    expect(points).toEqual(
      expect.arrayContaining([
        [{ "mcp.method.name": "tools/call", "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search" }, 1],
        [
          { "mcp.method.name": "tools/call", "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "broken", "error.type": "mcp.error" },
          1,
        ],
        [{ "mcp.method.name": "tools/list" }, 1],
      ]),
    );
    expect(points).toHaveLength(3);
    // No span without span export.
    expect(test.spans()).toEqual([]);
    await handler.closeAll();
  });

  it("makes a CLIENT span `tools/call {tool}` under the call's trace context with span export", async () => {
    test = startTestTelemetry({ spans: true });
    const handler = createMcpHandler({ vaults, logger: quiet as never, open });
    const signal = new AbortController().signal;
    await handler.call(undefined, { server, effectId: "e1", name: "search", arguments: {}, traceparent: TRACEPARENT }, signal);
    await handler.call(undefined, { server, effectId: "e2", name: "broken", arguments: {}, traceparent: TRACEPARENT }, signal);
    const spans = test.spans();
    expect(spans.map((span) => span.name)).toEqual(["tools/call search", "tools/call broken"]);
    for (const span of spans) {
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(span.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    }
    expect(spans[1]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[1]!.attributes["error.type"]).toBe("mcp.error");
    await handler.closeAll();
  });
});

describe("an HTTP tool's metrics", () => {
  it("records each request's duration by method and status, an error answer with its status", async () => {
    test = startTestTelemetry();
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () =>
        req.url === "/fail"
          ? res.writeHead(503).end("down")
          : res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const options = { headers: {}, policy: {}, signal: new AbortController().signal, limits: RUNTIME_LIMIT_DEFAULTS };
      expect(await callHttpTarget({ url: `${origin}/ok` }, {}, options)).toEqual({ kind: "completed", output: { ok: true } });
      expect((await callHttpTarget({ url: `${origin}/fail`, method: "GET" }, {}, options)).kind).toBe("failed");
      const points = (await test.points("http.client.request.duration")).map((point) => [point.attributes, countOf(point)]);
      expect(points).toEqual([
        [{ "http.request.method": "POST", "http.response.status_code": 200 }, 1],
        [{ "http.request.method": "GET", "http.response.status_code": 503, "error.type": "503" }, 1],
      ]);
      // Never the URL or its host.
      expect(JSON.stringify(points)).not.toContain("127.0.0.1");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("core's metrics", () => {
  it("records a turn's duration when it ends, by agent and outcome", async () => {
    test = startTestTelemetry();
    const end = (type: string, payload: Record<string, unknown>) => ({ type, payload }) as never;
    recordTurnEnds({
      events: [
        end("turn.completed", { durationMs: 1500, manifest: { name: "coder", version: 2 } }),
        end("turn.failed", { durationMs: 200, manifest: { name: "coder", version: 2 } }),
        end("turn.cancelled", { durationMs: 300, agentId: "users/alice/coder" }),
        // A turn the Runtime has no start for, and a pause, record nothing.
        end("turn.completed", {}),
        end("turn.paused", { durationMs: 10 }),
      ],
    });
    const points = (await test.points("gen_ai.invoke_agent.duration")).map((point) => [point.attributes, countOf(point)]);
    expect(points).toEqual([
      [{ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "coder" }, 1],
      [{ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "coder", "error.type": "turn.failed" }, 1],
      // Never the Agent's id, which may name a person.
      [{ "gen_ai.operation.name": "invoke_agent", "error.type": "cancelled" }, 1],
    ]);
  });

  it("records a queued message's wait only once its transaction commits", async () => {
    test = startTestTelemetry();
    const committed: (() => void)[] = [];
    const t = { afterCommit: (listener: () => void) => void committed.push(listener) };
    recordQueueWaits(t, [{ createdAt: "2030-01-01T00:00:00.000Z" }, { createdAt: "2030-01-01T00:00:01.000Z" }], "taken", () =>
      Date.parse("2030-01-01T00:00:03.000Z"),
    );
    expect(await test.points("nylorun.queue.wait")).toEqual([]);
    for (const listener of committed) listener();
    const [point] = await test.points("nylorun.queue.wait");
    expect(point!.attributes).toEqual({ "nylorun.queue.outcome": "taken" });
    expect(point!.value).toMatchObject({ count: 2, sum: 5 });
  });

  it("runs a store's after-commit listeners on commit, never on rollback", async () => {
    const store = await createTestSessionStore();
    const ran: string[] = [];
    await store.tx(async (t) => t.afterCommit(() => ran.push("committed")));
    await expect(
      store.tx(async (t) => {
        t.afterCommit(() => ran.push("rolled back"));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(ran).toEqual(["committed"]);
  });
});
