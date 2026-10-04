import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "../src/compatibility.js";
import { parseTranscriptEvent, type LiveEvent } from "../src/contracts.js";

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
        capabilityId: "sandbox",
        toolName: "read",
        output: "text",
      })
    );
    const failed = parseTranscriptEvent(
      event("tool.completed", {
        callId: "call-1",
        invocationId: "inv_2",
        capabilityId: "sandbox",
        toolName: "read",
        error: { code: "sandbox.error", message: "missing" },
      })
    );
    expect(ok?.type).toBe("tool.completed");
    expect(failed?.payload).toMatchObject({ error: { code: "sandbox.error" } });
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
