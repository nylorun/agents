import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import {
  Agent,
  createClient,
  tool,
} from "@nylorun/agents";
import { createA2aHandler, toNodeListener } from "@nylorun/agents/a2a";
import type { ModelProvider } from "../../src/core/provider.js";
import { startTestTenant } from "../support/tenant.js";
import { serveAgents, type ServedAgents } from "../support/endpoint.js";

/**
 * A2A v1 exit gate: partners reach the Tenant's agents through a gateway
 * (`createA2aHandler` behind a stub app server that authenticates `x-partner-key`), and the
 * Runtime speaks A2A 1.0 JSON-RPC. The official `@a2a-js/sdk` client drives the main flows;
 * raw JSON-RPC checks the exact wire answers.
 */

const APP = "a2a-e2e-app-token-aaaaaaaaaaaaaaaa";
const PARTNERS: Record<string, string | { subject: string; agents: string[] }> = {
  "key-acme": "a2a:acme",
  "key-beta": "a2a:beta",
  "key-limited": { subject: "a2a:limited", agents: ["support"] },
};

type Step = { text?: string; call?: { name: string; args: object } };
const SCRIPTS: Record<string, { steps: Step[]; closing: (results: string) => string }> = {
  support: { steps: [], closing: () => "Hello from support." },
  refunds: {
    steps: [{ text: "Checking.", call: { name: "ask_order", args: {} } }],
    closing: (results) => `Refund issued for ${/demo-\d+/.exec(results)?.[0] ?? "nothing"}.`,
  },
  guarded: {
    steps: [{ call: { name: "save", args: { note: "hi" } } }],
    closing: () => "Saved.",
  },
  slow: {
    steps: [{ text: "Starting.", call: { name: "wait", args: {} } }],
    closing: () => "Finished.",
  },
};

/** Plays each agent's script, one step per model call within a turn. */
function scriptedModel(): ModelProvider {
  const baseline = new Map<string, number>();
  return async (effect) => {
    const script = SCRIPTS[effect.agentId]!;
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const results = prompt.filter((item) => item.kind === "tool-result");
    if (!baseline.has(effect.turnId)) baseline.set(effect.turnId, results.length);
    const index = results.length - baseline.get(effect.turnId)!;
    const step = script.steps[index];
    if (!step)
      return {
        output: [{ type: "text", text: script.closing(JSON.stringify(results.slice(-1))) }],
      };
    return {
      output: [
        ...(step.text ? [{ type: "text", text: step.text }] : []),
        ...(step.call
          ? [
              {
                type: "tool-call",
                id: `call-${effect.turnId}-${index}`,
                name: step.call.name,
                args: step.call.args,
              },
            ]
          : []),
      ],
    };
  };
}

let release: () => void = () => {};
let held: Promise<void> = Promise.resolve();

const support = Agent({ id: "support", name: "Support", description: "Answers questions." }).build();
const refunds = Agent({ id: "refunds", name: "Refunds" })
  .tools(
      tool({
        name: "ask_order",
        input: z.object({}),
        async run(_input, ctx) {
          const order = await ctx.ask("Which order number?");
          return { order: String(order) };
        },
      }),
  )
  .build();
const guarded = Agent({ id: "guarded", name: "Guarded" })
  .tools(
      tool({
        name: "save",
        input: z.object({ note: z.string() }),
        approval: () => "Save this note?",
        async run() {
          return { saved: true };
        },
      }),
  )
  .build();
const slow = Agent({ id: "slow", name: "Slow" })
  .tools(
      tool({
        name: "wait",
        input: z.object({}),
        async run() {
          await held;
          return "waited";
        },
      }),
  )
  .build();

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let connection: ServedAgents;
let server: Server;
let base: string;

beforeAll(async () => {
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: null,
    modelProvider: scriptedModel(),
  });
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  connection = serveAgents({
    agents: [support, refunds, guarded, slow],
    application: client,
    implementationVersion: "dev",
  });
  await connection.ready;
  const handler = createA2aHandler({
    basePath: "/a2a",
    agents: [support, refunds, guarded, slow],
    client,
    subject: (request) => PARTNERS[request.headers.get("x-partner-key") ?? ""],
    card: {
      provider: { organization: "Example Inc.", url: "https://example.com" },
      securitySchemes: {
        partnerKey: { apiKeySecurityScheme: { location: "header", name: "X-Partner-Key" } },
      },
      securityRequirements: [{ schemes: { partnerKey: { list: [] } } }],
    },
  });
  const listener = toNodeListener(handler);
  server = createServer((req, res) => {
    // The app server's rule: a client never names a subject or scopes itself.
    for (const name of Object.keys(req.headers))
      if (name.startsWith("nylorun-")) delete req.headers[name];
    listener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`;
}, 60_000);

afterAll(async () => {
  release();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await connection?.close();
  await runtime?.close();
});

/** A `fetch` that sends a partner's key, as a partner's A2A client would. */
function fetchAs(key: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-partner-key", key);
    return fetch(input, { ...init, headers });
  };
}

async function sdkClient(agent: string, key = "key-acme"): Promise<Client> {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl: fetchAs(key) })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: fetchAs(key) }),
    })
  );
  return factory.createFromUrl(`${base}/${agent}/.well-known/agent-card.json`, "");
}

let messages = 0;
/** A `SendMessageRequest` from its ProtoJSON wire form. */
function send(
  text: string,
  options: { taskId?: string; contextId?: string; returnImmediately?: boolean; messageId?: string } = {}
) {
  return SendMessageRequest.fromJSON({
    message: {
      messageId: options.messageId ?? `m-${++messages}`,
      role: "ROLE_USER",
      parts: [{ text }],
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.contextId ? { contextId: options.contextId } : {}),
    },
    ...(options.returnImmediately ? { configuration: { returnImmediately: true } } : {}),
  });
}

/** The task a `SendMessage` returned (v1 never answers with a bare message). */
function taskOf(result: unknown) {
  expect(result).toHaveProperty("status");
  return result as {
    id: string;
    contextId: string;
    status: { state: TaskState; message?: { parts: { content?: { $case: string; value: unknown } }[] } };
    artifacts: { artifactId: string; parts: { content?: { $case: string; value: unknown } }[] }[];
    history: { role: number; parts: { content?: { $case: string; value: unknown } }[] }[];
  };
}

const textOf = (parts: { content?: { $case: string; value: unknown } }[] | undefined) =>
  (parts ?? []).map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("");

interface RpcOptions {
  key?: string | null;
  version?: string | null;
  agent?: string;
  body?: string;
}

/** One raw JSON-RPC call through the gateway. */
async function rpc(method: string, params: unknown, options: RpcOptions = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.key !== null) headers["x-partner-key"] = options.key ?? "key-acme";
  if (options.version !== null) headers["A2A-Version"] = options.version ?? "1.0";
  const response = await fetch(`${base}/${options.agent ?? "support"}`, {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const wireMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  message: { messageId: `raw-${++messages}`, role: "ROLE_USER", parts: [{ text }], ...extra },
});

describe("Agent Card", () => {
  it("is served by the gateway with its URL, provider and schemes", async () => {
    const response = await fetch(`${base}/support/.well-known/agent-card.json`);
    expect(response.status).toBe(200);
    const card = await response.json();
    expect(card).toMatchObject({
      name: "Support",
      description: "Answers questions.",
      version: "dev",
      supportedInterfaces: [
        { url: `${base}/support`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
      provider: { organization: "Example Inc.", url: "https://example.com" },
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securityRequirements: [{ schemes: { partnerKey: { list: [] } } }],
      skills: [{ id: "support", name: "Support", description: "Answers questions.", tags: [] }],
    });
    expect(JSON.stringify(card)).not.toContain("instructions");
  });

  it("is 404 for an agent the gateway does not serve", async () => {
    expect((await fetch(`${base}/nope/.well-known/agent-card.json`)).status).toBe(404);
  });
});

describe("the official A2A client", () => {
  it("sends a blocking message and gets the completed task", async () => {
    const client = await sdkClient("support");
    const task = taskOf(await client.sendMessage(send("Hi")));
    expect(task.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(textOf(task.artifacts[0]!.parts)).toBe("Hello from support.");
    expect(task.history.map((m) => textOf(m.parts))).toEqual(["Hi", "Hello from support."]);
    const again = taskOf(await client.getTask({ id: task.id, historyLength: 0 } as never));
    expect(again.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(again.history ?? []).toEqual([]);
  });

  it("answers the agent's question on the same task", async () => {
    const client = await sdkClient("refunds");
    const asked = taskOf(await client.sendMessage(send("Refund my last order")));
    expect(asked.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(textOf(asked.status.message?.parts)).toBe("Which order number?");
    const done = taskOf(
      await client.sendMessage(send("demo-123", { taskId: asked.id, contextId: asked.contextId }))
    );
    expect(done.id).toBe(asked.id);
    expect(done.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(textOf(done.artifacts[0]!.parts)).toBe("Refund issued for demo-123.");
  });

  it("returns immediately and lets the caller poll", async () => {
    let unblock!: () => void;
    held = new Promise((resolve) => (unblock = resolve));
    release = unblock;
    const client = await sdkClient("slow");
    const started = taskOf(await client.sendMessage(send("Go", { returnImmediately: true })));
    expect(started.status.state).toBe(TaskState.TASK_STATE_WORKING);
    unblock();
    let state = started.status.state;
    for (let i = 0; i < 100 && state !== TaskState.TASK_STATE_COMPLETED; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = taskOf(await client.getTask({ id: started.id } as never)).status.state;
    }
    expect(state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("cancels a working task, idempotently", async () => {
    held = new Promise(() => {});
    const client = await sdkClient("slow");
    const started = taskOf(await client.sendMessage(send("Go", { returnImmediately: true })));
    const cancelled = taskOf(await client.cancelTask({ id: started.id } as never));
    expect(cancelled.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    const again = taskOf(await client.cancelTask({ id: started.id } as never));
    expect(again.status.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
});

describe("contexts and retries", () => {
  it("runs a new task in the same context on the same conversation", async () => {
    const first = await rpc("SendMessage", wireMessage("One"));
    const contextId = first.body.result.task.contextId;
    const second = await rpc("SendMessage", wireMessage("Two", { contextId }));
    const task = second.body.result.task;
    expect(task.contextId).toBe(contextId);
    expect(task.id).not.toBe(first.body.result.task.id);
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("returns the same task for a retried message", async () => {
    const params = wireMessage("Once");
    const first = await rpc("SendMessage", params);
    const retry = await rpc("SendMessage", params);
    expect(retry.body.result.task.id).toBe(first.body.result.task.id);
    const reused = await rpc("SendMessage", {
      message: { ...params.message, parts: [{ text: "Different" }] },
    });
    expect(reused.body.error.code).toBe(-32602);
  });

  it("keeps each partner to its own tasks", async () => {
    const mine = await rpc("SendMessage", wireMessage("Mine"));
    const taskId = mine.body.result.task.id;
    const theirs = await rpc("GetTask", { id: taskId }, { key: "key-beta" });
    expect(theirs.body.error.code).toBe(-32001);
    const cancel = await rpc("CancelTask", { id: taskId }, { key: "key-beta" });
    expect(cancel.body.error.code).toBe(-32001);
  });
});

describe("explicit answers for what v1 does not do", () => {
  it.each([
    ["ListTasks", {}, -32004],
    ["SendStreamingMessage", { message: {} }, -32004],
    ["SubscribeToTask", { id: "x" }, -32004],
    ["CreateTaskPushNotificationConfig", {}, -32003],
    ["GetExtendedAgentCard", {}, -32004],
    ["tasks/send", {}, -32601],
  ])("%s", async (method, params, code) => {
    const { status, body } = await rpc(method, params);
    expect(status).toBe(200);
    expect(body.error.code).toBe(code);
    expect(body.error.data[0]["@type"]).toBe("type.googleapis.com/google.rpc.ErrorInfo");
  });

  it("refuses a missing version as 0.3", async () => {
    const { body } = await rpc("SendMessage", wireMessage("Hi"), { version: null });
    expect(body.error.code).toBe(-32009);
  });

  it("accepts the version as a query parameter", async () => {
    const response = await fetch(`${base}/support?A2A-Version=1.0`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-partner-key": "key-acme" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "SendMessage", params: wireMessage("Hi") }),
    });
    const body = await response.json();
    expect(body.id).toBe(9);
    expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("answers invalid JSON with a parse error", async () => {
    const { body } = await rpc("", undefined, { body: "{" });
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });

  it("refuses files and mismatched contexts", async () => {
    const file = await rpc("SendMessage", {
      message: { messageId: "f-1", role: "ROLE_USER", parts: [{ url: "https://x/y.pdf" }] },
    });
    expect(file.body.error.code).toBe(-32005);
    const task = (await rpc("SendMessage", wireMessage("Hi"))).body.result.task;
    const mismatch = await rpc(
      "SendMessage",
      wireMessage("Hi", { taskId: task.id, contextId: "other" })
    );
    expect(mismatch.body.error.code).toBe(-32602);
    const terminal = await rpc("SendMessage", wireMessage("More", { taskId: task.id }));
    expect(terminal.body.error.code).toBe(-32004);
    const done = await rpc("CancelTask", { id: task.id });
    expect(done.body.error.code).toBe(-32002);
  });

  it("pauses an approval as INPUT_REQUIRED, refuses a reply, and cancels", async () => {
    const asked = (await rpc("SendMessage", wireMessage("Save it"), { agent: "guarded" })).body
      .result.task;
    expect(asked.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(asked.status.message.parts).toEqual([{ text: "Save this note?" }]);
    const reply = await rpc("SendMessage", wireMessage("yes", { taskId: asked.id }), {
      agent: "guarded",
    });
    expect(reply.body.error.code).toBe(-32004);
    expect(reply.body.error.message).toContain("approval");
    const cancelled = await rpc("CancelTask", { id: asked.id }, { agent: "guarded" });
    expect(cancelled.body.result.status.state).toBe("TASK_STATE_CANCELED");
  });
});

describe("the gateway and the Runtime route", () => {
  it("answers 401 without a partner, and 404 for an agent the partner may not use", async () => {
    expect((await rpc("GetTask", { id: "x" }, { key: null })).status).toBe(401);
    expect((await rpc("GetTask", { id: "x" }, { key: "key-limited", agent: "refunds" })).status).toBe(
      404
    );
    expect((await rpc("GetTask", { id: "x" }, { key: "key-limited" })).body.error.code).toBe(-32001);
  });

  it("needs a subject with sessions:own at the Runtime", async () => {
    const call = (headers: Record<string, string>) =>
      fetch(`${runtime.url}/v1/a2a/agents/support`, {
        method: "POST",
        headers: { ...runtime.headers(), "content-type": "application/json", "A2A-Version": "1.0", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }),
      });
    const noSubject = await call({});
    expect(noSubject.status).toBe(400);
    expect((await noSubject.json()).code).toBe("subject_required");
    const readOnly = await call({ "Nylorun-Subject": "a2a:acme", "Nylorun-Scopes": "agents:read" });
    expect(readOnly.status).toBe(403);
    const card = await fetch(`${runtime.url}/v1/a2a/agents/support/card`, {
      headers: runtime.headers(),
    });
    expect(card.status).toBe(200);
    expect((await card.json()).supportedInterfaces).toEqual([]);
  });
});
