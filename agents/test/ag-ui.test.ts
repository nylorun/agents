import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
} from "@nylorun/core/compatibility";
import type { LiveEvent } from "@nylorun/core/contracts";
import { AgentsClient } from "../src/client.js";
import { createAgUiHandler } from "../src/ag-ui/index.js";
import { messagesFromEvents } from "../src/ag-ui/history.js";
import { sseFrame } from "../src/ag-ui/sse.js";
import { RunTranslator } from "../src/ag-ui/translate.js";

const TENANT = "tn_00000000000000000000000001";
const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";

function health(features: readonly string[] = HOST_PROTOCOL.features) {
  return Response.json({
    status: "ok",
    service: "nylorun-runtime",
    version: "0.9.0-beta",
    protocol: { ...HOST_PROTOCOL, features: [...features] },
    coreVersion: "0.4.0-beta",
    hostId: "host_00000000000000000000000001",
    pid: 1,
  });
}

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

/** A client whose Runtime answers `/health` and records every other request. */
function fakeClient(
  options: {
    features?: readonly string[];
    respond?: (url: URL, init?: RequestInit) => Response | undefined;
  } = {}
) {
  const requests: { method: string; path: string }[] = [];
  /** What each request sent besides method and path, in the same order. */
  const sent: { subject: string | null; scopes: string | null; body?: unknown }[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    tenant: TENANT,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return health(options.features);
      requests.push({ method: init?.method ?? "GET", path: url.pathname });
      const headers = new Headers(init?.headers);
      sent.push({
        subject: headers.get("nylorun-subject"),
        scopes: headers.get("nylorun-scopes"),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      return (
        options.respond?.(url, init) ??
        Response.json({ status: "rejected", message: "no" }, { status: 404 })
      );
    },
  });
  return { client, requests, sent };
}

const runBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    threadId: "t1",
    runId: "r1",
    messages: [{ id: "m1", role: "user", content: "hi" }],
    tools: [],
    context: [],
    ...extra,
  });

describe("createAgUiHandler routing", () => {
  const { client, requests, sent } = fakeClient();
  const handler = createAgUiHandler({
    basePath: "/api/agui/",
    agents: ["bot", { id: "helper" } as never],
    client,
    subject: (request) => request.headers.get("x-user") ?? undefined,
  });
  const call = (path: string, init: RequestInit = {}) =>
    handler.fetch(
      new Request(`http://app.test${path}`, {
        ...init,
        headers: { "x-user": "ada", ...(init.headers as object) },
      })
    );

  it("answers 404 for paths outside basePath, unknown shapes and agents outside the list", async () => {
    for (const path of [
      "/other/bot",
      "/api/aguix/bot",
      "/api/agui",
      "/api/agui/bot/extra",
      "/api/agui/bot/threads/t1/unknown",
      "/api/agui/bot/threads//messages",
      "/api/agui/%E0%A4%A",
    ])
      expect((await call(path, { method: "POST" })).status, path).toBe(404);
    expect(
      (await call("/api/agui/secret", { method: "POST", body: runBody() })).status
    ).toBe(404);
    expect((await call("/api/agui/secret/threads/t1/messages")).status).toBe(404);
    expect(requests).toEqual([]);
  });

  it("answers 405 with Allow for a known path and the wrong method", async () => {
    const run = await call("/api/agui/bot");
    expect(run.status).toBe(405);
    expect(run.headers.get("allow")).toBe("POST");
    const history = await call("/api/agui/helper/threads/t1/messages", {
      method: "POST",
    });
    expect(history.status).toBe(405);
    expect(history.headers.get("allow")).toBe("GET");
    const cancel = await call("/api/agui/bot/threads/t1/cancel");
    expect(cancel.headers.get("allow")).toBe("POST");
  });

  it("answers 401 without a subject and 400 for bad input or frontend tools", async () => {
    const anonymous = await handler.fetch(
      new Request("http://app.test/api/agui/bot", { method: "POST", body: runBody() })
    );
    expect(anonymous.status).toBe(401);
    expect((await call("/api/agui/bot", { method: "POST", body: "{" })).status).toBe(
      400
    );
    const tools = await call("/api/agui/bot", {
      method: "POST",
      body: runBody({
        tools: [{ name: "x", description: "x", parameters: { type: "object" } }],
      }),
    });
    expect(tools.status).toBe(400);
    expect(requests).toEqual([]);
  });

  it("answers an empty history for a thread that never ran, from a per-subject session", async () => {
    sent.splice(0);
    const response = await call("/api/agui/bot/threads/t1/messages");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    const other = await handler.fetch(
      new Request("http://app.test/api/agui/bot/threads/t1/messages", {
        headers: { "x-user": "bob" },
      })
    );
    expect(await other.json()).toEqual([]);
    const paths = requests.splice(0).map((r) => r.path);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^\/v1\/sessions\/[0-9a-f]{32}\/items$/);
    expect(paths[0]).not.toBe(paths[1]);
    // Each call acts for its subject, so the Runtime enforces the separation too.
    expect(sent.splice(0).map(({ subject, scopes }) => ({ subject, scopes }))).toEqual([
      { subject: "ada", scopes: "sessions:own" },
      { subject: "bob", scopes: "sessions:own" },
    ]);
  });
});

describe("createAgUiHandler acting for subjects", () => {
  it("keeps the session's identity over the host's session parameters", async () => {
    const { client, requests, sent } = fakeClient({
      respond: (url, init) =>
        init?.method === "PUT" && url.pathname.startsWith("/v1/sessions/")
          ? Response.json({ id: "x" })
          : undefined,
    });
    const handler = createAgUiHandler({
      agents: ["bot"],
      client,
      scopes: ["sessions:own", "vaults:own"],
      subject: () => "ada",
      session: () =>
        ({ id: "chosen", ownerUserId: "eve", agentId: "other", info: { a: 1 } }) as never,
    });
    await handler.fetch(new Request("http://app.test/bot", { method: "POST", body: runBody() }));
    const put = requests.findIndex((r) => r.method === "PUT");
    expect(requests[put]!.path).toMatch(/^\/v1\/sessions\/[0-9a-f]{32}$/);
    expect(sent[put]).toMatchObject({
      subject: "ada",
      scopes: "sessions:own vaults:own",
      body: { agentId: "bot", ownerUserId: "ada", info: { a: 1 } },
    });
  });

  it("answers 400 when the Runtime refuses what the client sent", async () => {
    const { client } = fakeClient({
      respond: () =>
        Response.json({ status: "rejected", message: "Invalid cursor" }, { status: 400 }),
    });
    const handler = createAgUiHandler({ agents: ["bot"], client, subject: () => "ada" });
    const response = await handler.fetch(new Request("http://app.test/bot/threads/t1/messages"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The request was rejected",
      code: "invalid_request",
    });
  });

  it("refuses unknown scopes when it is created", () => {
    const { client } = fakeClient();
    expect(() =>
      createAgUiHandler({
        agents: ["bot"],
        client,
        scopes: ["sessions:all" as never],
        subject: () => "ada",
      })
    ).toThrow(/Unknown scope/);
  });

  it("answers 500 when the host names a subject the Runtime cannot", async () => {
    const { client, requests } = fakeClient();
    const handler = createAgUiHandler({ agents: ["bot"], client, subject: () => "host" });
    const response = await handler.fetch(
      new Request("http://app.test/bot/threads/t1/messages")
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "subject_invalid" });
    expect(requests).toEqual([]);
  });
});

describe("createAgUiHandler against an older Runtime", () => {
  it("answers 502 naming the missing feature and calls nothing else", async () => {
    const { client, requests } = fakeClient({ features: PROTOCOL_FEATURES });
    const handler = createAgUiHandler({
      agents: ["bot"],
      client,
      subject: () => "ada",
    });
    const response = await handler.fetch(
      new Request("http://app.test/bot", { method: "POST", body: runBody() })
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "runtime_feature_missing",
    });
    expect(requests).toEqual([]);
  });

  it("requires subject-headers as well as transcript-events", async () => {
    const { client, requests } = fakeClient({
      features: HOST_PROTOCOL.features.filter((f) => f !== "subject-headers"),
    });
    const handler = createAgUiHandler({ agents: ["bot"], client, subject: () => "ada" });
    const response = await handler.fetch(
      new Request("http://app.test/bot", { method: "POST", body: runBody() })
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe("runtime_feature_missing");
    expect(body.error).toContain("subject-headers");
    expect(body.error).not.toContain("transcript-events");
    expect(requests).toEqual([]);
  });
});

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
