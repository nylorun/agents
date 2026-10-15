/** Row to span (R7.2): the mapping, the ids, what never leaves, and the content opt-ins. */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { effectSpanOf, traceIdOf, turnSpanOf } from "../../src/traces/ids.js";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import {
  SPAN_KIND,
  STATUS,
  TRACE_CONTENT_KINDS,
  spanOf,
  truncate,
  turnTraceOf,
  type OtlpSpan,
  type SpanSettings,
  type TraceContentKind,
} from "../../src/traces/map.js";
import { SESSION, TENANT, TURN, message, row } from "./rows.js";

const key = randomBytes(32);
const contentBytes = RUNTIME_LIMIT_DEFAULTS.traceContentBytes;
const plain: SpanSettings = { key, content: new Set(), contentBytes };
const all: SpanSettings = { key, content: new Set(TRACE_CONTENT_KINDS), contentBytes };
const ids = { tenantId: TENANT, sessionId: SESSION, turnId: TURN };
const attrs = (span: OtlpSpan | undefined) =>
  Object.fromEntries(
    (span?.attributes ?? []).map(({ key: name, value }) => [
      name,
      value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? value.arrayValue?.values.map((v) => v.stringValue),
    ]),
  );
const ms = (nanos: string) => Number(BigInt(nanos) / 1_000_000n);

/** A turn of a coding agent, as R7.1 and R7.3 record it. */
function turnRows() {
  return [
    message(),
    row(
      "message.assistant",
      {
        invocationId: "inv_6",
        text: "Looking",
        toolCalls: [{ callId: "toolu_01", name: "search", input: { query: "flaky" } }],
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        finishReason: "tool-calls",
        usage: { inputTokens: 2140, outputTokens: 96 },
        effectId: `${TURN}:0:model:inv_6`,
        durationMs: 2720,
        gate: { startedAt: "2026-10-11T09:14:00.120Z", endedAt: "2026-10-11T09:14:02.840Z" },
        firstTokenMs: 640,
        meteredUsage: { inputTokens: 2140, outputTokens: 97, totalTokens: 2237, cachedTokens: 1800, costUsd: 0.0081 },
      },
      { source: { kind: "harness", id: "ours" }, evidence: "claimed", time: "2026-10-11T09:14:02.900Z" },
    ),
    row(
      "tool.completed",
      {
        callId: "toolu_01",
        invocationId: "inv_7",
        effectId: `${TURN}:0:tool:inv_7`,
        toolName: "linear__search",
        status: "completed",
        kind: "mcp",
        server: "linear",
        tool: "search",
        attempts: 1,
        durationMs: 812,
        gate: { startedAt: "2026-10-11T09:14:02.900Z", endedAt: "2026-10-11T09:14:03.710Z" },
        policy: { decision: "ask", reason: "writes", approvedBy: "app:alice@example.com" },
        output: { issues: ["WEB-412"] },
      },
      { time: "2026-10-11T09:14:03.800Z" },
    ),
    row(
      "tool.completed",
      {
        callId: "toolu_02",
        invocationId: "inv_8",
        effectId: `${TURN}:0:tool:inv_8`,
        toolName: "bash",
        status: "completed",
        kind: "sandbox",
        attempts: 1,
        durationMs: 3440,
        output: { exitCode: 1 },
        error: { code: "sandbox.exit", message: "exit 1 at /home/alice" },
      },
      { time: "2026-10-11T09:14:06.350Z" },
    ),
    row("transcript.updated", { keep: 0, entries: [], length: 0 }, { visibility: "internal" }),
    row(
      "model.failed",
      { invocationId: "inv_9", code: "rate_limited", message: "429 for alice", retryable: true, effectId: `${TURN}:1:model:inv_9`, durationMs: 50 },
      { time: "2026-10-11T09:14:07.000Z" },
    ),
    row("turn.paused", { interactions: [{ invocationId: "inv_10", interaction: { id: "i1", kind: "approval" } }] }),
    row(
      "command.approve",
      { type: "approve", requestId: "r2", idempotencyKey: "idem-approve-secret", interactionId: "i1", approved: true },
      { source: { kind: "client", id: "alice@example.com" }, principal: { kind: "subject", id: "alice@example.com" } },
    ),
    row(
      "turn.completed",
      {
        output: "Opened PR #482",
        durationMs: 12930,
        pausedMs: 100,
        agentId: "coder",
        totals: { steps: 3, tokens: 13796, costUsd: 0.0492 },
      },
      { time: "2026-10-11T09:14:12.930Z" },
    ),
  ];
}

function spans(settings: SpanSettings, rows = turnRows()) {
  const turn = turnTraceOf(settings, ids, rows[0]);
  return rows.map((r) => spanOf(r, turn, settings));
}

describe("spanOf", () => {
  it("maps each crossing to one span under the turn's span, with derived ids", () => {
    const out = spans(plain);
    const traceId = traceIdOf(key, TENANT, SESSION, TURN);
    const turnSpan = turnSpanOf(key, TURN);
    const [start, chat, mcp, bash, internal, failed, paused, approve, root] = out;
    expect(start).toBeUndefined();
    expect(internal).toBeUndefined();
    for (const span of out.filter(Boolean)) expect(span!.traceId).toBe(traceId);
    for (const span of [chat, mcp, bash, failed, paused, approve])
      expect(span!.parentSpanId).toBe(turnSpan);

    expect(root).toMatchObject({ spanId: turnSpan, name: "invoke_agent coder", kind: SPAN_KIND.internal, status: { code: STATUS.ok } });
    expect(root!.parentSpanId).toBeUndefined();
    expect(ms(root!.endTimeUnixNano) - ms(root!.startTimeUnixNano)).toBe(12930);
    expect(attrs(root)).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "coder",
      "gen_ai.conversation.id": SESSION,
      "nylorun.turn.status": "completed",
      "nylorun.turn.steps": "3",
      "nylorun.usage.cost_usd": 0.0492,
      "nylorun.principal.kind": "subject",
    });

    // The gate's own measurement, not the window; usage from the gate, with the mismatch noted.
    expect(chat).toMatchObject({ spanId: effectSpanOf(key, `${TURN}:0:model:inv_6`), name: "chat claude-sonnet-4-5", kind: SPAN_KIND.client });
    expect(chat!.startTimeUnixNano).toBe(String(Date.parse("2026-10-11T09:14:00.120Z") * 1_000_000));
    expect(chat!.endTimeUnixNano).toBe(String(Date.parse("2026-10-11T09:14:02.840Z") * 1_000_000));
    expect(attrs(chat)).toMatchObject({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.response.finish_reasons": ["tool-calls"],
      "gen_ai.usage.input_tokens": "2140",
      "gen_ai.usage.output_tokens": "97",
      "gen_ai.usage.cache_read.input_tokens": "1800",
      "gen_ai.response.time_to_first_chunk": 0.64,
      "nylorun.usage.source": "gate",
      "nylorun.usage.mismatch": true,
      "nylorun.effect.window_ms": "2720",
      "nylorun.source.kind": "harness",
      "nylorun.source.id": "ours",
      "nylorun.evidence": "claimed",
    });

    // The span is named by the model's name; the tool's identity rides beside it (protocol 15).
    expect(mcp).toMatchObject({ name: "execute_tool linear__search", kind: SPAN_KIND.internal, status: { code: STATUS.ok } });
    expect(ms(mcp!.endTimeUnixNano) - ms(mcp!.startTimeUnixNano)).toBe(810);
    expect(attrs(mcp)).toMatchObject({
      "gen_ai.tool.call.id": "toolu_01",
      "gen_ai.tool.type": "extension",
      "nylorun.tool.kind": "mcp",
      "nylorun.tool.server": "linear",
      "nylorun.tool.identity": "search",
      "gen_ai.tool.name": "linear__search",
      "nylorun.tool.attempts": "1",
      "nylorun.policy.decision": "ask",
      "nylorun.policy.reason": "writes",
    });
    // A sandbox tool has no gate: its window, ending at the row.
    expect(ms(bash!.endTimeUnixNano) - ms(bash!.startTimeUnixNano)).toBe(3440);
    expect(bash!.status).toEqual({ code: STATUS.error });
    expect(attrs(bash)).toMatchObject({ "gen_ai.tool.type": "function", "error.type": "sandbox.exit" });

    expect(failed).toMatchObject({ name: "chat", status: { code: STATUS.error } });
    expect(failed!.status.message).toBeUndefined();
    expect(attrs(failed)["error.type"]).toBe("rate_limited");
    expect(paused!.startTimeUnixNano).toBe(paused!.endTimeUnixNano);
    expect(approve).toMatchObject({ name: "command.approve" });
    expect(attrs(approve)).toMatchObject({ "nylorun.interaction.id": "i1", "nylorun.interaction.approved": true });
  });

  it("gives the same spans twice", () => {
    const rows = turnRows();
    expect(JSON.stringify(spans(plain, rows))).toBe(JSON.stringify(spans(plain, rows)));
  });

  it("uses the inbound trace, and parents the turn's span under the caller's", () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const rows = turnRows();
    rows[0] = message({ trace: { traceparent } });
    const out = spans(plain, rows);
    for (const span of out.filter(Boolean)) expect(span!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(out.at(-1)!.parentSpanId).toBe("00f067aa0ba902b7");
    expect(out.at(-1)!.spanId).toBe(turnSpanOf(key, TURN));
  });

  it("makes no span for a row without a turn, and none for a command.message", () => {
    expect(spanOf(row("environment.state", { state: "running", backend: "virtual" }, { turnId: null }), turnTraceOf(plain, ids), plain)).toBeUndefined();
    expect(spanOf(message(), turnTraceOf(plain, ids), plain)).toBeUndefined();
  });

  it("never exports a person's id, an idempotency key, or content by default", () => {
    const text = JSON.stringify(spans(plain));
    for (const secret of [
      "alice@example.com",
      "idem-secret-key",
      "idem-approve-secret",
      "Fix the failing test",
      "Looking",
      "WEB-412",
      "429 for alice",
      "/home/alice",
      "Opened PR",
      "flaky",
    ])
      expect(text).not.toContain(secret);
  });

  it("exports content per kind when the installation opts in", () => {
    const only = (kind: TraceContentKind) => JSON.stringify(spans({ key, content: new Set([kind]), contentBytes }));
    expect(only("user")).toContain("Fix the failing test");
    expect(only("user")).not.toContain("WEB-412");
    expect(only("outputs")).toContain("Looking");
    expect(only("outputs")).toContain("Opened PR #482");
    expect(only("tool-results")).toContain("WEB-412");
    expect(only("errors")).toContain("429 for alice");
    expect(only("errors")).not.toContain("Looking");
    const everything = JSON.stringify(spans(all));
    for (const value of ["Fix the failing test", "Looking", "WEB-412", "429 for alice"]) expect(everything).toContain(value);
    // Even with every kind on, no person's id or idempotency key.
    for (const secret of ["alice@example.com", "idem-secret-key", "idem-approve-secret"]) expect(everything).not.toContain(secret);
  });

  it("cuts content at the Tenant's traceContentBytes, on a character boundary", () => {
    const rows = [message({ content: "é".repeat(10_000) }), row("turn.completed", { output: null, agentId: "coder" })];
    const root = spans(all, rows)[1]!;
    const input = root.attributes.find((a) => a.key === "gen_ai.input.messages")!.value.stringValue!;
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(contentBytes);
    expect(input).not.toContain("�");
    expect(Buffer.byteLength(truncate("x".repeat(9000), contentBytes))).toBe(contentBytes);
    expect(truncate("short", contentBytes)).toBe("short");
    // A lowered limit cuts shorter.
    const lowered = spans({ ...all, contentBytes: 100 }, rows)[1]!;
    const cut = lowered.attributes.find((a) => a.key === "gen_ai.input.messages")!.value.stringValue!;
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(100);
  });

  it("marks an uncertain call as an error on its span", () => {
    const span = spanOf(row("effect.uncertain", { effectId: `${TURN}:0:model:inv_1` }), turnTraceOf(plain, ids), plain);
    expect(span).toMatchObject({ spanId: effectSpanOf(key, `${TURN}:0:model:inv_1`), name: "chat", status: { code: STATUS.error } });
  });

  it("maps a flow's HTTP stage from node.completed", () => {
    const span = spanOf(
      row("node.completed", {
        path: "root/0",
        kind: "http",
        key: "notify",
        effectId: `${TURN}:0:flow:notify`,
        status: "completed",
        durationMs: 30,
        gate: { startedAt: "2026-10-11T09:14:00.000Z", endedAt: "2026-10-11T09:14:00.020Z" },
      }),
      turnTraceOf(plain, ids),
      plain,
    );
    expect(span).toMatchObject({ name: "execute_tool notify", status: { code: STATUS.ok } });
    expect(ms(span!.endTimeUnixNano) - ms(span!.startTimeUnixNano)).toBe(20);
    expect(attrs(span)).toMatchObject({ "nylorun.tool.kind": "http", "nylorun.flow.path": "root/0" });
  });
});
