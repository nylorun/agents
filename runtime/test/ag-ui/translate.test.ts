/**
 * The AG-UI translation the Runtime's endpoint uses: Runtime events to AG-UI events for one
 * run, a thread's messages rebuilt from its log, and SSE framing. Moved from the SDK with the
 * translation itself.
 */
import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@nylorun/core/contracts";
import { messagesFromEvents } from "../../src/api/ag-ui/history.js";
import { sessionIdFor } from "../../src/api/ag-ui/session-id.js";
import { sseFrame } from "../../src/api/ag-ui/sse.js";
import { RunTranslator } from "../../src/api/ag-ui/translate.js";

const TENANT = "tn_00000000000000000000000001";

let seq = 0;
function event(type: string, payload: unknown, turnId = "turn_1"): LiveEvent {
  seq += 1;
  return {
    eventId: `ev_${seq}`,
    sessionId: "s1",
    tenantId: TENANT,
    turnId,
    cursor: `c${seq}`,
    createdAt: "2026-09-28T00:00:00.000Z",
    type,
    payload,
  };
}

describe("RunTranslator", () => {
  it("maps a model step to text then tool calls, and results by call id", () => {
    const t = new RunTranslator("t1", "r1");
    const step = t.translate(
      event("message.assistant", {
        invocationId: "inv_m",
        text: "Looking.",
        toolCalls: [{ callId: "call-1", name: "lookup", input: { id: 1 } }],
      })
    );
    expect(step.events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
    ]);
    expect(step.events[3]).toMatchObject({
      toolCallId: "call-1",
      toolCallName: "lookup",
      parentMessageId: "inv_m",
    });
    // An approval request is no result; the interrupt names the model's call.
    expect(
      t.translate(
        event("action.completed", {
          actionId: "a1",
          kind: "tool",
          callId: "call-1",
          invocationId: "inv_t",
          result: { kind: "interaction-required" },
        })
      ).events
    ).toEqual([]);
    const paused = t.translate(
      event("turn.paused", {
        interactions: [
          {
            invocationId: "inv_t",
            interaction: { id: "i1", kind: "approval", prompt: "OK?" },
            status: "interaction",
          },
        ],
      })
    );
    expect(paused.finished).toBe(true);
    expect(paused.events[0]).toMatchObject({
      type: "RUN_FINISHED",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "i1", reason: "tool_approval", toolCallId: "call-1" }],
      },
    });
  });

  it("closes each call once, whichever event carries its result", () => {
    const t = new RunTranslator("t1", "r1");
    const done = {
      actionId: "a1",
      kind: "tool",
      callId: "call-1",
      invocationId: "inv_t",
      result: { kind: "completed", output: { ok: true } },
    };
    expect(t.translate(event("action.completed", done)).events).toHaveLength(1);
    expect(t.translate(event("action.completed", done)).events).toEqual([]);
    const failed = t.translate(
      event("tool.completed", {
        callId: "call-2",
        invocationId: "inv_2",
        capabilityId: "sandbox",
        toolName: "read",
        error: { code: "sandbox.error", message: "missing" },
      })
    );
    expect(failed.events[0]).toMatchObject({
      type: "TOOL_CALL_RESULT",
      toolCallId: "call-2",
      messageId: "call-2:result",
    });
    const delegated = t.translate(
      event("delegation.completed", {
        agent: { id: "child", path: "bot/child", delegationId: "inv_3" },
        callId: "call-3",
        status: "completed",
        outcome: { kind: "completed", output: "answer" },
      })
    );
    expect(delegated.events[0]).toMatchObject({ toolCallId: "call-3", content: "answer" });
  });

  it("skips a delegated agent's own work", () => {
    const t = new RunTranslator("t1", "r1");
    const agent = { id: "child", path: "bot/child", delegationId: "inv_3" };
    expect(
      t.translate(
        event("message.assistant", {
          invocationId: "inv_c",
          text: "inner",
          toolCalls: [],
          agent,
        })
      ).events
    ).toEqual([]);
  });

  it("shows a workflow's output as text, but not after a model step or on reattach", () => {
    const output = event("turn.completed", { output: "result" });
    expect(new RunTranslator("t1", "r1").translate(output).events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const reattached = new RunTranslator("t1", "r1", { reattached: true });
    expect(reattached.translate(output).events.map((e) => e.type)).toEqual([
      "RUN_FINISHED",
    ]);
  });

  it("maps both turn.failed shapes to RUN_ERROR", () => {
    const t = new RunTranslator("t1", "r1");
    expect(
      t.translate(event("turn.failed", { error: { code: "model.x", message: "bad" } }))
        .events[0]
    ).toMatchObject({ type: "RUN_ERROR", code: "model.x", message: "bad" });
    expect(t.translate(event("turn.failed", { message: "threw" })).events[0]).toMatchObject({
      type: "RUN_ERROR",
      code: "turn.failed",
      message: "threw",
    });
  });
});

describe("messagesFromEvents", () => {
  it("rebuilds the ids a live run gives each message", () => {
    const messages = messagesFromEvents([
      event("command.message", { type: "message", idempotencyKey: "m1", content: "hi" }),
      event("message.assistant", {
        invocationId: "inv_m",
        text: "",
        toolCalls: [{ callId: "call-1", name: "lookup", input: {} }],
      }),
      event("action.pending", {
        actionId: "a1",
        kind: "tool",
        callId: "call-1",
        invocationId: "inv_t",
        input: {},
      }),
      event("action.completed", {
        actionId: "a1",
        kind: "tool",
        callId: "call-1",
        invocationId: "inv_t",
        result: { kind: "completed", output: "shipped" },
      }),
      event("message.assistant", { invocationId: "inv_n", text: "Shipped.", toolCalls: [] }),
      event("turn.completed", { output: "Shipped." }),
    ]);
    expect(messages).toEqual([
      { id: "m1", role: "user", content: "hi" },
      {
        id: "inv_m",
        role: "assistant",
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
        ],
      },
      { id: "call-1:result", role: "tool", toolCallId: "call-1", content: "shipped" },
      { id: "inv_n", role: "assistant", content: "Shipped." },
    ]);
  });
});

describe("sseFrame", () => {
  it("writes the cursor as id only when given", () => {
    const e = { type: "RUN_STARTED" } as never;
    expect(sseFrame(e)).toBe('data: {"type":"RUN_STARTED"}\n\n');
    expect(sseFrame(e, "YzE=")).toBe('id: YzE=\ndata: {"type":"RUN_STARTED"}\n\n');
    expect(sseFrame(e, "bad\nid")).toBe('data: {"type":"RUN_STARTED"}\n\n');
  });
});

describe("sessionIdFor", () => {
  it("keeps the ids the SDK handler gave threads before the move", () => {
    // Recorded from the SDK handler's algorithm (@nylorun/agents 0.8.0-beta): existing
    // threads keep their sessions.
    expect(sessionIdFor("ada", "bot", "t1")).toBe("9c0e2d129de5c15f6056e83c64f82cb0");
    expect(sessionIdFor("ada", "bot", "t1")).not.toBe(sessionIdFor("bob", "bot", "t1"));
    expect(sessionIdFor("ada", "bot", "t1")).not.toBe(sessionIdFor("ada", "bot", "t2"));
  });
});
