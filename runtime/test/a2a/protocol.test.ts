import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@nylorun/core/contracts";
import {
  A2aError,
  checkVersion,
  jsonRpcError,
  parseEnvelope,
  parseSendParams,
  parseTaskParams,
} from "../../src/a2a/protocol.js";
import {
  buildTask,
  contextSessionId,
  parseTaskId,
  taskIdOf,
} from "../../src/a2a/tasks.js";
import { agentCard } from "../../src/a2a/card.js";

/** The A2A error a call throws, as `kind` and message. */
function a2aError(run: () => unknown): A2aError {
  try {
    run();
  } catch (error) {
    if (error instanceof A2aError) return error;
    throw error;
  }
  throw new Error("expected an A2aError");
}

const message = (overrides: Record<string, unknown> = {}) => ({
  message: {
    messageId: "m-1",
    role: "ROLE_USER",
    parts: [{ text: "Hello" }],
    ...overrides,
  },
});

let seq = 0;
function event(type: string, turnId: string | null, payload: unknown): LiveEvent {
  seq += 1;
  return {
    eventId: `e-${seq}`,
    sessionId: "s",
    tenantId: "tn",
    turnId,
    cursor: `c-${seq}`,
    createdAt: new Date(Date.UTC(2026, 8, 29, 10, 0, seq)).toISOString(),
    type,
    payload,
  } as LiveEvent;
}

describe("JSON-RPC envelope", () => {
  it("parses a request and keeps its id", () => {
    const parsed = parseEnvelope(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "GetTask", params: { id: "x" } })
    );
    expect(parsed).toEqual({
      ok: true,
      request: { id: 7, method: "GetTask", params: { id: "x" } },
    });
  });

  it.each([
    ["not JSON", "{", "parse", null],
    ["an array", "[]", "invalidRequest", null],
    ["no id", JSON.stringify({ jsonrpc: "2.0", method: "GetTask" }), "invalidRequest", null],
    ["wrong version", JSON.stringify({ jsonrpc: "1.0", id: 1, method: "GetTask" }), "invalidRequest", 1],
    ["no method", JSON.stringify({ jsonrpc: "2.0", id: "a" }), "invalidRequest", "a"],
    ["params not an object", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: [] }), "invalidRequest", 2],
  ])("refuses %s", (_name, text, kind, id) => {
    const parsed = parseEnvelope(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe(kind);
    expect(parsed.id).toBe(id);
  });

  it("answers errors with the code and a google.rpc.ErrorInfo", () => {
    expect(
      jsonRpcError(3, new A2aError("taskNotFound", "Task not found", { taskId: "t" }))
    ).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32001,
        message: "Task not found",
        data: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "TASK_NOT_FOUND",
            domain: "a2a-protocol.org",
            metadata: { taskId: "t" },
          },
        ],
      },
    });
  });

  it("adds a google.rpc.BadRequest for an invalid field", () => {
    const body = jsonRpcError(
      1,
      new A2aError("invalidParams", "At least one part is required", {}, "message.parts")
    ) as { error: { code: number; data: unknown[] } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data[1]).toEqual({
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [
        { field: "message.parts", description: "At least one part is required" },
      ],
    });
  });
});

describe("A2A-Version", () => {
  it("accepts 1.0, ignoring a patch number", () => {
    expect(() => checkVersion("1.0")).not.toThrow();
    expect(() => checkVersion(" 1.0.1 ")).not.toThrow();
  });

  it.each([[undefined], [""], ["0.3"], ["1.1"], ["2.0"]])("refuses %s", (value) => {
    expect(a2aError(() => checkVersion(value)).kind).toBe("versionNotSupported");
  });
});

describe("SendMessage params", () => {
  it("joins text parts", () => {
    expect(
      parseSendParams(message({ parts: [{ text: "a" }, { text: "b" }] }))
    ).toEqual({ messageId: "m-1", input: { content: "a\nb" }, returnImmediately: false });
  });

  it("takes one data part as JSON input, with the configuration", () => {
    expect(
      parseSendParams({
        ...message({ parts: [{ data: { orderId: "o-1" } }], contextId: "ctx" }),
        configuration: { returnImmediately: true, historyLength: 2 },
      })
    ).toEqual({
      messageId: "m-1",
      contextId: "ctx",
      input: { data: { orderId: "o-1" } },
      returnImmediately: true,
      historyLength: 2,
    });
  });

  it.each([
    ["no message", {}, "invalidParams", "message"],
    ["an agent role", message({ role: "ROLE_AGENT" }), "invalidParams", "message.role"],
    ["no message id", message({ messageId: "" }), "invalidParams", "message.messageId"],
    ["a long message id", message({ messageId: "m".repeat(201) }), "invalidParams", "message.messageId"],
    ["no parts", message({ parts: [] }), "invalidParams", "message.parts"],
    ["a part with two kinds", message({ parts: [{ text: "a", data: 1 }] }), "invalidParams", "message.parts[0]"],
    ["blank text", message({ parts: [{ text: "  " }] }), "invalidParams", "message.parts"],
    ["a file", message({ parts: [{ url: "https://x/y.pdf" }] }), "contentTypeNotSupported", undefined],
    ["text and data", message({ parts: [{ text: "a" }, { data: 1 }] }), "contentTypeNotSupported", undefined],
    ["a push config", { ...message(), configuration: { taskPushNotificationConfig: { url: "x" } } }, "pushNotSupported", undefined],
    ["a negative history length", { ...message(), configuration: { historyLength: -1 } }, "invalidParams", "configuration.historyLength"],
  ])("refuses %s", (_name, params, kind, field) => {
    const error = a2aError(() => parseSendParams(params as Record<string, unknown>));
    expect(error.kind).toBe(kind);
    expect(error.field).toBe(field);
  });

  it("needs a task id for GetTask and CancelTask", () => {
    expect(parseTaskParams({ id: "t", historyLength: 0 })).toEqual({ id: "t", historyLength: 0 });
    expect(a2aError(() => parseTaskParams({})).kind).toBe("invalidParams");
  });
});

describe("task ids", () => {
  it("round-trips the context and turn", () => {
    const id = taskIdOf("ctx:1/α", "4f2c1a9e-0000-4000-8000-000000000000");
    expect(parseTaskId(id)).toEqual({
      contextId: "ctx:1/α",
      turnId: "4f2c1a9e-0000-4000-8000-000000000000",
    });
  });

  it.each([["x"], ["t2.YQ.turn"], ["t1..turn"], ["t1.YQ.turn.extra"], ["t1.YQ=.turn"], ["t1.YQ.tu rn"]])(
    "refuses %s",
    (id) => expect(parseTaskId(id)).toBeUndefined()
  );

  it("derives one session per subject, agent and context", () => {
    const one = contextSessionId("a2a:acme", "support", "ctx");
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(contextSessionId("a2a:other", "support", "ctx")).not.toBe(one);
    expect(contextSessionId("a2a:acme", "billing", "ctx")).not.toBe(one);
  });
});

describe("buildTask", () => {
  const turnId = "turn-1";
  const taskId = taskIdOf("ctx", turnId);
  const sent = event("command.message", turnId, {
    type: "message",
    idempotencyKey: "a2a:m-1",
    content: "Refund my order",
  });

  it("is undefined for a turn the session never had", () => {
    expect(
      buildTask({
        contextId: "ctx",
        turnId: "other",
        session: { status: "completed", activeTurnId: null, lastTurnId: turnId },
        events: [],
      })
    ).toBeUndefined();
  });

  it("maps a paused question to INPUT_REQUIRED with the prompt", () => {
    const paused = event("turn.paused", turnId, {
      interactions: [
        { invocationId: "i", interaction: { id: "q-1", kind: "response", prompt: "Which order?" }, status: "interaction" },
      ],
    });
    const task = buildTask({
      contextId: "ctx",
      turnId,
      session: {
        status: "paused",
        activeTurnId: turnId,
        waits: [
          { invocationId: "i", interaction: { id: "q-1", kind: "response", prompt: "Which order?" }, status: "interaction" },
        ],
      },
      events: [sent, event("message.assistant", turnId, { invocationId: "i", text: "Let me check.", toolCalls: [] }), paused],
    })!;
    expect(task.id).toBe(taskId);
    expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(task.status.message).toEqual({
      messageId: "q-1",
      role: "ROLE_AGENT",
      parts: [{ text: "Which order?" }],
      contextId: "ctx",
      taskId,
    });
    expect(task.history!.map((m) => [m.role, m.messageId, m.parts])).toEqual([
      ["ROLE_USER", "m-1", [{ text: "Refund my order" }]],
      ["ROLE_AGENT", expect.any(String), [{ text: "Let me check." }]],
      ["ROLE_AGENT", "q-1", [{ text: "Which order?" }]],
    ]);
  });

  it("maps completion to an output artifact, text or JSON", () => {
    const text = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "completed", activeTurnId: null, lastTurnId: turnId },
      events: [sent, event("turn.completed", turnId, { output: "Refund issued." })],
      historyLength: 0,
    })!;
    expect(text.status.state).toBe("TASK_STATE_COMPLETED");
    expect(text.artifacts).toEqual([
      { artifactId: "output", name: "output", parts: [{ text: "Refund issued." }] },
    ]);
    expect(text).not.toHaveProperty("history");
    const data = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "completed", activeTurnId: null, lastTurnId: turnId },
      events: [sent, event("turn.completed", turnId, { output: { refunded: 12 } })],
    })!;
    expect(data.artifacts![0]!.parts).toEqual([
      { data: { refunded: 12 }, mediaType: "application/json" },
    ]);
  });

  it("falls back to the session row until the terminal event is in the stream", () => {
    const task = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "completed", activeTurnId: null, lastTurnId: turnId, lastOutput: "Done." },
      events: [sent],
    })!;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts![0]!.parts).toEqual([{ text: "Done." }]);
  });

  it("prefers the terminal event over a later session state", () => {
    const task = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "cancelled", activeTurnId: null, lastTurnId: turnId },
      events: [sent, event("turn.completed", turnId, { output: "ok" })],
    })!;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("reports a failure by code only, and a cancellation", () => {
    const failed = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "failed", activeTurnId: null, lastTurnId: turnId },
      events: [sent, event("turn.failed", turnId, { error: { code: "model_error", message: "secret detail" } })],
    })!;
    expect(failed.status.state).toBe("TASK_STATE_FAILED");
    expect(JSON.stringify(failed.status.message)).toContain("model_error");
    expect(JSON.stringify(failed)).not.toContain("secret detail");
    const cancelled = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "cancelled", activeTurnId: null, lastTurnId: turnId },
      events: [sent, event("turn.cancelled", turnId, {})],
    })!;
    expect(cancelled.status.state).toBe("TASK_STATE_CANCELED");
  });

  it("keeps a delegated agent's words out of history and honors historyLength", () => {
    const task = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "runnable", activeTurnId: turnId },
      events: [
        sent,
        event("message.assistant", turnId, { invocationId: "a", text: "inner", toolCalls: [], agent: { path: "x" } }),
        event("message.assistant", turnId, { invocationId: "b", text: "outer", toolCalls: [] }),
      ],
      historyLength: 1,
    })!;
    expect(task.status.state).toBe("TASK_STATE_WORKING");
    expect(task.history!.map((m) => m.parts)).toEqual([[{ text: "outer" }]]);
  });

  it("says when an uncertain action holds the task", () => {
    const task = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "uncertain", activeTurnId: turnId },
      events: [sent],
    })!;
    expect(task.status.state).toBe("TASK_STATE_WORKING");
    expect(JSON.stringify(task.status.message)).toContain("uncertain");
  });
});

describe("agentCard", () => {
  it("publishes name, description and one skill, never instructions or tools", () => {
    const card = agentCard("support", {
      manifest: {
        id: "support",
        name: "Support",
        description: "Answers questions.",
        instructions: "secret",
      } as never,
      implementationVersion: "1.2.0",
    });
    expect(card).toEqual({
      name: "Support",
      description: "Answers questions.",
      supportedInterfaces: [],
      version: "1.2.0",
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      skills: [{ id: "support", name: "Support", description: "Answers questions.", tags: [] }],
    });
  });
});
