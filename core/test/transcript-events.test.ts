import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "../src/compatibility.js";
import {
  EVENT_SCHEMAS,
  isEmptyAssistantMessage,
  parseTranscriptEvent,
  type LiveEvent,
} from "../src/contracts.js";

const event = (type: string, payload: unknown): LiveEvent => ({
  schema: "nylorun.event/2",
  eventId: "ev_1",
  sessionId: "s1",
  tenantId: "tn_1",
  runId: null,
  turnId: "turn_1",
  incarnation: 0,
  epoch: 1,
  seq: 0,
  cursor: "c1",
  time: "2026-09-28T00:00:00.000Z",
  schemaVersion: 1,
  source: { kind: "loop", id: "runtime" },
  evidence: "observed",
  visibility: "public",
  retention: "full",
  type,
  payload,
});

describe("parseTranscriptEvent", () => {
  it("types message.assistant and keeps unknown fields", () => {
    const parsed = parseTranscriptEvent(
      event("message.assistant", {
        invocationId: "inv_1",
        text: "Looking it up.",
        toolCalls: [{ callId: "call-1", name: "lookup", input: { id: 1 } }],
        later: true,
      })
    );
    expect(parsed?.type).toBe("message.assistant");
    if (parsed?.type !== "message.assistant") throw new Error("narrowing");
    expect(parsed.payload.toolCalls[0]?.callId).toBe("call-1");
    expect((parsed.payload as { later?: boolean }).later).toBe(true);
    expect(parsed.cursor).toBe("c1");
  });

  it("accepts both turn.failed shapes", () => {
    expect(
      parseTranscriptEvent(
        event("turn.failed", { error: { code: "x", message: "y" } })
      )
    ).toBeDefined();
    expect(
      parseTranscriptEvent(event("turn.failed", { message: "boom" }))
    ).toBeDefined();
  });

  it("types tool.completed with output or error", () => {
    const ok = parseTranscriptEvent(
      event("tool.completed", {
        callId: "call-1",
        invocationId: "inv_2",
        toolName: "read",
        output: "text",
      })
    );
    const failed = parseTranscriptEvent(
      event("tool.completed", {
        callId: "call-1",
        invocationId: "inv_2",
        toolName: "read",
        error: { code: "sandbox.error", message: "missing" },
      })
    );
    expect(ok?.type).toBe("tool.completed");
    expect(failed?.payload).toMatchObject({ error: { code: "sandbox.error" } });
  });

  it("types the timing of a model call's outcome, a tool call's and a turn's (R7.1)", () => {
    const gate = { startedAt: "2026-10-11T00:00:00.100Z", endedAt: "2026-10-11T00:00:01.000Z" };
    const assistant = parseTranscriptEvent(
      event("message.assistant", {
        invocationId: "inv_1",
        text: "",
        toolCalls: [],
        effectId: "turn_1:0:model:1",
        durationMs: 1200,
        gate,
        firstTokenMs: 300,
        meteredUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.001 },
      })
    );
    expect(assistant?.payload).toMatchObject({ durationMs: 1200, gate, firstTokenMs: 300 });
    if (assistant?.type !== "message.assistant") throw new Error("narrowing");
    expect(isEmptyAssistantMessage(assistant.payload)).toBe(true);
    expect(isEmptyAssistantMessage({ text: "", toolCalls: [{}] })).toBe(false);
    expect(isEmptyAssistantMessage({ text: "hi", toolCalls: [] })).toBe(false);
    expect(
      parseTranscriptEvent(
        event("context.compacted", { trigger: "threshold", tokensBefore: 9, tokensAfter: 3, partial: true })
      )?.payload
    ).toMatchObject({ partial: true });
    expect(
      parseTranscriptEvent(
        event("tool.completed", {
          callId: "call-1",
          invocationId: "inv_2",
          toolName: "send",
          effectId: "turn_1:0:tool:1",
          gate,
          policy: { decision: "ask", reason: "sends mail", approvedBy: "app:ada" },
          output: "sent",
        })
      )?.payload
    ).toMatchObject({ policy: { decision: "ask" }, gate });
    expect(
      parseTranscriptEvent(
        event("tool.completed", {
          callId: "call-1",
          invocationId: "inv_2",
          toolName: "send",
          policy: { decision: "allow", reason: "x" },
        })
      )
    ).toBeUndefined();
    const totals = { steps: 2, tokens: 30, costUsd: 0.01 };
    for (const [type, payload] of [
      ["turn.completed", { output: "ok" }],
      ["turn.failed", { message: "boom" }],
      ["turn.cancelled", {}],
    ] as const)
      expect(
        parseTranscriptEvent(event(type, { ...payload, durationMs: 5, agentId: "bot", totals }))?.payload
      ).toMatchObject({ durationMs: 5, agentId: "bot", totals });
    expect(
      EVENT_SCHEMAS["node.completed"].shape.payload.safeParse({
        path: "fetch",
        kind: "http",
        key: "fetch",
        effectId: "turn_1:0:tool:2",
        status: "completed",
        durationMs: 4,
        gate,
      }).success
    ).toBe(true);
  });

  it("returns undefined for other types and malformed payloads", () => {
    expect(parseTranscriptEvent(event("sandbox.exec", {}))).toBeUndefined();
    expect(
      parseTranscriptEvent(event("message.assistant", { text: "no ids" }))
    ).toBeUndefined();
    expect(parseTranscriptEvent(event("toString", {}))).toBeUndefined();
  });

  it("is advertised as an optional Host feature", () => {
    expect(HOST_PROTOCOL.features).toContain("transcript-events");
    for (const removed of ["derived-principals", "subject-tokens", "browser-access"])
      expect(HOST_PROTOCOL.features).not.toContain(removed);
  });
});
