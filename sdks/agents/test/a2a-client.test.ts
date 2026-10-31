import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A2A_EXTENSIONS,
  A2aError,
  A2aPushVerificationError,
  createA2aClient,
  listTurnChanges,
  readEffects,
  readFiles,
  readInteraction,
  readProgress,
  readTelemetry,
  verifyA2aPush,
  type StreamResponse,
  type Task,
} from "../src/a2a/index.js";
import * as root from "../src/index.js";
import { RuntimeError } from "../src/http.js";

const KEY = "a".repeat(64);
const AGENT_URL = "https://agents.example/v1/a2a/agents/coding";

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body?: any;
}

function fakeAgent(respond: (sent: Sent) => Response | unknown = () => ({ task: TASK })) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    };
    sent.push(request);
    const answer = respond(request);
    if (answer instanceof Response) return answer;
    return Response.json({ jsonrpc: "2.0", id: request.body?.id ?? null, result: answer });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const TASK: Task = {
  id: "t1.turn_1",
  contextId: "ctx_1",
  status: { state: "TASK_STATE_WORKING", timestamp: "2026-10-31T10:00:00.000Z" },
};

describe("createA2aClient", () => {
  it("sends SendMessage as JSON-RPC 2.0 with the version, extensions, key and subject", async () => {
    const { fetch, sent } = fakeAgent();
    const a2a = createA2aClient({ url: AGENT_URL, key: KEY, subject: "u:org_1:user_1", fetch });
    const task = await a2a.send({
      messageId: "m1",
      contextId: "ctx_1",
      parts: [{ text: "Build the portal" }],
      metadata: { source: "bot" },
      delivery: "reject",
      push: { url: "https://bot.example/a2a/push", token: "tok" },
      returnImmediately: true,
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    expect(task).toEqual(TASK);
    const [request] = sent;
    expect(request!.url).toBe(AGENT_URL);
    expect(request!.method).toBe("POST");
    expect(request!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request!.headers.get("nylorun-subject")).toBe("u:org_1:user_1");
    expect(request!.headers.get("nylorun-scopes")).toBe("sessions:own");
    expect(request!.headers.get("nylorun-protocol")).toMatch(/^\d+$/);
    expect(request!.headers.get("a2a-version")).toBe("1.0");
    expect(request!.headers.get("a2a-extensions")).toBe(
      Object.values(A2A_EXTENSIONS).join(", ")
    );
    expect(request!.headers.get("content-type")).toBe("application/json");
    expect(request!.headers.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    );
    expect(request!.body).toEqual({
      jsonrpc: "2.0",
      id: expect.any(String),
      method: "SendMessage",
      params: {
        message: {
          messageId: "m1",
          role: "ROLE_USER",
          contextId: "ctx_1",
          parts: [{ text: "Build the portal" }],
          metadata: { source: "bot", delivery: "reject" },
        },
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: { url: "https://bot.example/a2a/push", token: "tok" },
        },
      },
    });
  });

  it("sends no subject or key headers it was not given, and only the extensions asked for", async () => {
    const { fetch, sent } = fakeAgent();
    const a2a = createA2aClient({ url: AGENT_URL, fetch, extensions: [] });
    await a2a.send({ messageId: "m1", parts: [{ text: "hi" }] });
    const headers = sent[0]!.headers;
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("nylorun-subject")).toBe(false);
    expect(headers.has("a2a-extensions")).toBe(false);
    expect(sent[0]!.body.params).toEqual({
      message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] },
    });
  });

  it("refuses a subject the Runtime cannot name", () => {
    expect(() => createA2aClient({ url: AGENT_URL, subject: "ü" })).toThrow(TypeError);
    expect(() => createA2aClient({ url: "ftp://x" })).toThrow(TypeError);
  });

  it("gets, lists and cancels tasks", async () => {
    const { fetch, sent } = fakeAgent((request) =>
      request.body.method === "ListTasks"
        ? { tasks: [TASK], nextPageToken: "", pageSize: 50, totalSize: 1 }
        : TASK
    );
    const a2a = createA2aClient({ url: AGENT_URL, key: KEY, fetch });
    expect(await a2a.get("t1.turn_1", { historyLength: 2 })).toEqual(TASK);
    expect(await a2a.cancel("t1.turn_1")).toEqual(TASK);
    const page = await a2a.list({
      contextId: "ctx_1",
      status: "TASK_STATE_WORKING",
      statusTimestampAfter: "2026-10-31T00:00:00.000Z",
      pageSize: 10,
    });
    expect(page.tasks).toEqual([TASK]);
    expect(sent.map((request) => [request.body.method, request.body.params])).toEqual([
      ["GetTask", { id: "t1.turn_1", historyLength: 2 }],
      ["CancelTask", { id: "t1.turn_1" }],
      [
        "ListTasks",
        {
          contextId: "ctx_1",
          status: "TASK_STATE_WORKING",
          statusTimestampAfter: "2026-10-31T00:00:00.000Z",
          pageSize: 10,
        },
      ],
    ]);
  });

  it("walks every page with listAll", async () => {
    const pages: Record<string, { tasks: Task[]; nextPageToken: string }> = {
      "": { tasks: [TASK], nextPageToken: "p2" },
      p2: { tasks: [{ ...TASK, id: "t2" }], nextPageToken: "p3" },
      p3: { tasks: [{ ...TASK, id: "t3" }], nextPageToken: "" },
    };
    const { fetch, sent } = fakeAgent((request) => ({
      ...pages[request.body.params.pageToken ?? ""],
      pageSize: 1,
      totalSize: 3,
    }));
    const a2a = createA2aClient({ url: AGENT_URL, fetch });
    const ids: string[] = [];
    for await (const task of a2a.listAll({ contextId: "ctx_1", pageSize: 1 })) ids.push(task.id);
    expect(ids).toEqual(["t1.turn_1", "t2", "t3"]);
    expect(sent.map((request) => request.body.params.pageToken)).toEqual([undefined, "p2", "p3"]);
    expect(sent.every((request) => request.body.params.contextId === "ctx_1")).toBe(true);
  });

  it("answers an interaction on its task with the interactions extension", async () => {
    const { fetch, sent } = fakeAgent();
    const a2a = createA2aClient({ url: AGENT_URL, fetch });
    await a2a.answer({
      taskId: "t1.turn_1",
      contextId: "ctx_1",
      interactionId: "eff_1",
      approved: true,
      messageId: "m2",
    });
    await a2a.answer({
      taskId: "t1.turn_1",
      contextId: "ctx_1",
      interactionId: "int_2",
      value: { choice: "b" },
      messageId: "m3",
    });
    expect(sent[0]!.body.params.message).toEqual({
      messageId: "m2",
      role: "ROLE_USER",
      taskId: "t1.turn_1",
      contextId: "ctx_1",
      parts: [{ data: { approved: true } }],
      extensions: [A2A_EXTENSIONS.interactions],
      metadata: { [A2A_EXTENSIONS.interactions]: { interactionId: "eff_1", approved: true } },
    });
    expect(sent[1]!.body.params.message.metadata).toEqual({
      [A2A_EXTENSIONS.interactions]: { interactionId: "int_2", value: { choice: "b" } },
    });
    await expect(
      a2a.answer({ taskId: "t", contextId: "c", interactionId: "i", messageId: "m" })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("turns a JSON-RPC error into A2aError with the ErrorInfo reason", async () => {
    const { fetch } = fakeAgent(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32004,
          message: "The context is busy",
          data: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "CONTEXT_BUSY",
              domain: "a2a-protocol.org",
              metadata: { contextId: "ctx_1" },
            },
          ],
        },
      })
    );
    const a2a = createA2aClient({ url: AGENT_URL, fetch });
    const error = await a2a
      .send({ messageId: "m1", contextId: "ctx_1", parts: [{ text: "hi" }] })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(A2aError);
    expect(error).toMatchObject({
      code: -32004,
      message: "The context is busy",
      reason: "CONTEXT_BUSY",
      metadata: { contextId: "ctx_1" },
    });
  });

  it("reads a JSON-RPC error sent with an HTTP error status, and HTTP refusals as RuntimeError", async () => {
    const rpcError = fakeAgent(() =>
      Response.json(
        { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Task not found" } },
        { status: 404 }
      )
    );
    const error = await createA2aClient({ url: AGENT_URL, fetch: rpcError.fetch })
      .get("missing")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(A2aError);
    expect(error).toMatchObject({ code: -32001, reason: undefined });

    const limited = fakeAgent(() =>
      Response.json({ code: "limit_exceeded", message: "Too many" }, { status: 429 })
    );
    const refused = await createA2aClient({ url: AGENT_URL, fetch: limited.fetch })
      .get("t")
      .catch((caught) => caught);
    expect(refused).toBeInstanceOf(RuntimeError);
    expect(refused.status).toBe(429);
  });

  it("refuses an answer that is a message, not a task", async () => {
    const { fetch } = fakeAgent(() => ({
      message: { messageId: "x", role: "ROLE_AGENT", parts: [{ text: "hi" }] },
    }));
    const error = await createA2aClient({ url: AGENT_URL, fetch })
      .send({ messageId: "m1", parts: [{ text: "hi" }] })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(A2aError);
  });

  it("reads the card from the Runtime's /card, or the gateway's well-known path", async () => {
    const card = { name: "coding", capabilities: { pushNotifications: true } };
    const runtime = fakeAgent(() => Response.json(card));
    expect(
      await createA2aClient({ url: AGENT_URL, key: KEY, subject: "u:o:u", fetch: runtime.fetch }).card()
    ).toEqual(card);
    expect(runtime.sent[0]!.url).toBe(`${AGENT_URL}/card`);
    expect(runtime.sent[0]!.method).toBe("GET");
    expect(runtime.sent[0]!.headers.get("nylorun-subject")).toBe("u:o:u");

    const gateway = fakeAgent(() => Response.json(card));
    await createA2aClient({ url: "https://api.example.com/a2a/support/", fetch: gateway.fetch }).card();
    expect(gateway.sent[0]!.url).toBe(
      "https://api.example.com/a2a/support/.well-known/agent-card.json"
    );
  });

  it("is exported from the package root too", () => {
    expect(root.createA2aClient).toBe(createA2aClient);
    expect(root.verifyA2aPush).toBe(verifyA2aPush);
    expect(root.A2A_EXTENSIONS).toBe(A2A_EXTENSIONS);
    expect(typeof root.listTurnChanges).toBe("function");
    expect(typeof root.readProgress).toBe("function");
  });
});

describe("listTurnChanges", () => {
  it("reads the change feed from a cursor", async () => {
    const page = {
      turns: [
        {
          turnId: "turn_1",
          sessionId: "s1",
          agentId: "coding",
          status: "completed",
          startedAt: "2026-10-31T10:00:00.000Z",
          endedAt: "2026-10-31T10:05:00.000Z",
          changedAt: "2026-10-31T10:05:00.000Z",
          totals: { steps: 3, tokens: 1200, costUsd: 0.02 },
          a2a: { contextId: "ctx_1", taskId: "t1.turn_1" },
        },
      ],
      cursor: "c2",
      hasMore: false,
    };
    const { fetch, sent } = fakeAgent(() => Response.json(page));
    expect(
      await listTurnChanges({ baseUrl: "https://agents.example/", key: KEY, changedAfter: "c1", limit: 200, fetch })
    ).toEqual(page);
    expect(sent[0]!.url).toBe("https://agents.example/v1/turns?changedAfter=c1&limit=200");
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent[0]!.headers.has("nylorun-subject")).toBe(false);

    await listTurnChanges({ baseUrl: "https://agents.example", key: KEY, sessionId: "s1", subject: "u:o:u", fetch });
    expect(sent[1]!.url).toBe("https://agents.example/v1/turns?sessionId=s1");
    expect(sent[1]!.headers.get("nylorun-subject")).toBe("u:o:u");
  });

  it("throws RuntimeError on an HTTP error", async () => {
    const { fetch } = fakeAgent(() => Response.json({ code: "not_found" }, { status: 404 }));
    await expect(listTurnChanges({ baseUrl: "https://agents.example", key: KEY, fetch })).rejects.toBeInstanceOf(
      RuntimeError
    );
  });
});

const SECRET_BYTES = Buffer.from("profile-v2-webhook-secret-bytes!");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function sign(id: string, timestamp: number, body: string, secret = SECRET_BYTES): string {
  return `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

describe("verifyA2aPush", () => {
  const update: StreamResponse = {
    statusUpdate: {
      taskId: "t1.turn_1",
      contextId: "ctx_1",
      status: { state: "TASK_STATE_WORKING", timestamp: "2026-10-31T10:00:00.000Z" },
    },
  };
  const body = JSON.stringify(update);
  const now = () => Math.floor(Date.now() / 1000);

  afterEach(() => vi.useRealTimers());

  it("returns the StreamResponse when the signature matches", async () => {
    const timestamp = now();
    const result = await verifyA2aPush({
      secret: SECRET,
      headers: new Headers({
        "webhook-id": "msg_1",
        "webhook-timestamp": String(timestamp),
        "webhook-signature": sign("msg_1", timestamp, body),
      }),
      body,
    });
    expect(result).toEqual(update);
  });

  it("takes node:http headers and a byte body", async () => {
    const timestamp = now();
    const result = await verifyA2aPush({
      secret: SECRET,
      headers: {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(timestamp),
        "webhook-signature": sign("msg_1", timestamp, body),
        "x-a2a-notification-token": "tok",
      },
      body: new TextEncoder().encode(body),
      token: "tok",
    });
    expect(result).toEqual(update);
  });

  it("accepts any one of several signatures", async () => {
    const timestamp = now();
    const other = Buffer.from("the-previous-secret-before-rotation");
    const result = await verifyA2aPush({
      secret: SECRET,
      headers: {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1a,abc ${sign("msg_1", timestamp, body, other)} ${sign("msg_1", timestamp, body)}`,
      },
      body,
    });
    expect(result).toEqual(update);
  });

  const failure = async (options: Parameters<typeof verifyA2aPush>[0]) => {
    const error = await verifyA2aPush(options).catch((caught) => caught);
    expect(error).toBeInstanceOf(A2aPushVerificationError);
    return (error as A2aPushVerificationError).reason;
  };

  it("refuses a bad signature, a changed body or another secret", async () => {
    const timestamp = now();
    const headers = (signature: string) => ({
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    });
    expect(await failure({ secret: SECRET, headers: headers("v1,AAAA"), body })).toBe("invalid_signature");
    expect(
      await failure({ secret: SECRET, headers: headers(sign("msg_1", timestamp, body)), body: `${body} ` })
    ).toBe("invalid_signature");
    expect(
      await failure({ secret: SECRET, headers: headers(sign("msg_2", timestamp, body)), body })
    ).toBe("invalid_signature");
    expect(
      await failure({
        secret: SECRET,
        headers: headers(sign("msg_1", timestamp, body, Buffer.from("another-secret"))),
        body,
      })
    ).toBe("invalid_signature");
    expect(await failure({ secret: SECRET, headers: { "webhook-id": "msg_1" }, body })).toBe(
      "missing_headers"
    );
  });

  it("refuses a timestamp outside the tolerance, either way", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
    const current = now();
    const at = (timestamp: number, toleranceSeconds?: number) =>
      verifyA2aPush({
        secret: SECRET,
        headers: {
          "webhook-id": "msg_1",
          "webhook-timestamp": String(timestamp),
          "webhook-signature": sign("msg_1", timestamp, body),
        },
        body,
        ...(toleranceSeconds !== undefined ? { toleranceSeconds } : {}),
      });
    await expect(at(current - 299)).resolves.toEqual(update);
    for (const timestamp of [current - 301, current + 301]) {
      const error = await at(timestamp).catch((caught) => caught);
      expect(error.reason).toBe("timestamp_out_of_range");
    }
    await expect(at(current - 3_000, 3_600)).resolves.toEqual(update);
    expect(
      await failure({
        secret: SECRET,
        headers: { "webhook-id": "m", "webhook-timestamp": "soon", "webhook-signature": "v1,AAAA" },
        body,
      })
    ).toBe("invalid_timestamp");
  });

  it("refuses a token that differs and a body that is not a StreamResponse", async () => {
    const timestamp = now();
    const signed = (text: string) => ({
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign("msg_1", timestamp, text),
      "x-a2a-notification-token": "other",
    });
    expect(await failure({ secret: SECRET, headers: signed(body), body, token: "tok" })).toBe(
      "invalid_token"
    );
    expect(await failure({ secret: SECRET, headers: signed("{}"), body: "{}" })).toBe("invalid_body");
    expect(await failure({ secret: "whsec_!!", headers: signed(body), body })).toBe("invalid_secret");
  });
});

describe("profile v2 readers", () => {
  const progress = {
    steps: [
      { label: "Inspect wikis and toolchain", state: "done", note: "Node 22, pnpm 9" },
      { label: "Build in parts", state: "active" },
      { label: "Bad", state: "exploded" },
      { label: "Package zip", state: "pending" },
    ],
  };

  it("reads progress from a status update push", () => {
    const push: StreamResponse = {
      statusUpdate: {
        taskId: "t1",
        contextId: "c1",
        status: { state: "TASK_STATE_WORKING" },
        metadata: { [A2A_EXTENSIONS.progress]: progress },
      },
    };
    expect(readProgress(push)).toEqual({
      steps: [
        { label: "Inspect wikis and toolchain", state: "done", note: "Node 22, pnpm 9" },
        { label: "Build in parts", state: "active" },
        { label: "Package zip", state: "pending" },
      ],
    });
    expect(readProgress(push.statusUpdate)?.steps).toHaveLength(3);
    expect(readTelemetry(push)).toBeUndefined();
  });

  it("reads telemetry and effects", () => {
    const update = {
      taskId: "t1",
      contextId: "c1",
      status: { state: "TASK_STATE_COMPLETED" as const },
      metadata: {
        [A2A_EXTENSIONS.telemetry]: {
          totals: { steps: 114, tokens: 2412833, costUsd: 18.42 },
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        },
        [A2A_EXTENSIONS.effects]: { uncertain: "eff_9" },
      },
    };
    expect(readTelemetry({ statusUpdate: update })).toEqual({
      totals: { steps: 114, tokens: 2412833, costUsd: 18.42 },
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    expect(readEffects(update)).toEqual({ uncertain: "eff_9" });
  });

  it("reads an open interaction from a task's status message", () => {
    const task: Task = {
      id: "t1",
      contextId: "c1",
      status: {
        state: "TASK_STATE_AUTH_REQUIRED",
        message: {
          messageId: "m",
          role: "ROLE_AGENT",
          parts: [{ text: "Approve github / create_pull_request?" }],
          extensions: [A2A_EXTENSIONS.interactions],
          metadata: {
            [A2A_EXTENSIONS.interactions]: {
              interactionId: "eff_01",
              kind: "approval",
              prompt: "Approve github / create_pull_request?",
              detail: { server: "github", tool: "create_pull_request" },
            },
          },
        },
      },
    };
    const expected = {
      interactionId: "eff_01",
      kind: "approval",
      prompt: "Approve github / create_pull_request?",
      detail: { server: "github", tool: "create_pull_request" },
    };
    expect(readInteraction(task)).toEqual(expected);
    expect(readInteraction({ task })).toEqual(expected);
    expect(readInteraction(task.status)).toEqual(expected);
    expect(readInteraction({ ...task, status: { state: "TASK_STATE_WORKING" } })).toBeUndefined();
  });

  it("reads files from a task's artifacts and an artifact update", () => {
    const file = {
      artifactId: "af_1:deepwiki-portal.zip",
      name: "deepwiki-portal.zip",
      parts: [{ url: "https://agents.example/v1/a2a/files/x", mediaType: "application/zip" }],
      metadata: {
        [A2A_EXTENSIONS.files]: {
          kind: "file",
          path: "deepwiki-portal.zip",
          version: 2,
          size: 2394141,
          sha256: "a561e811",
        },
      },
    };
    const output = { artifactId: "output", parts: [{ text: "Done" }] };
    const task: Task = {
      id: "t1",
      contextId: "c1",
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [output, file],
    };
    const expected = [
      {
        artifact: file,
        file: { kind: "file", path: "deepwiki-portal.zip", version: 2, size: 2394141, sha256: "a561e811" },
      },
    ];
    expect(readFiles(task)).toEqual(expected);
    expect(readFiles({ artifactUpdate: { taskId: "t1", contextId: "c1", artifact: file } })).toEqual(
      expected
    );
    expect(readFiles(file)).toEqual(expected);
    expect(readFiles(output)).toEqual([]);
    expect(readFiles(undefined)).toEqual([]);
  });
});
