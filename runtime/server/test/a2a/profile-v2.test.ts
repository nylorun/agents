import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createClient } from "@nylorun/agents";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { ModelProvider } from "../../src/core/provider.js";
import { A2A_EXTENSIONS, keepExtensions, parseExtensions } from "../../src/api/a2a/extensions.js";
import { pushRetry } from "../../src/api/a2a/push.js";
import { buildTask, contextSessionId, taskIdOf, updatesOf } from "../../src/api/a2a/tasks.js";
import { startTestTenant } from "../support/tenant.js";
import { startToolServer, type ToolServer } from "../support/tool-server.js";
import { setToolPolicy } from "../support/tool-policy.js";
import { deploy } from "../support/agents.js";

/**
 * The Nylorun A2A profile v2 conformance suite (A2A-E15): what a v2 caller (Nylorun Bot's
 * service) relies on, called the way it calls: straight to the Runtime with an application key
 * acting for a subject. Push signatures are verified here with `node:crypto` alone, as a receiver
 * that shares nothing with the Runtime would.
 */

const APP = "a2a-v2-app-token-aaaaaaaaaaaaaaaaaa";
const SECRET_KEY = Buffer.alloc(32, 7);
const SECRET = `whsec_${SECRET_KEY.toString("base64")}`;
const ALL = Object.values(A2A_EXTENSIONS);
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

type Step = { text?: string; call?: { name: string; args: object } };
const SCRIPTS: Record<string, { steps: Step[]; closing: string }> = {
  support: { steps: [], closing: "Hello from support." },
  guarded: { steps: [{ call: { name: "save", args: { note: "hi" } } }], closing: "Saved." },
  slow: { steps: [{ text: "Starting.", call: { name: "wait", args: {} } }], closing: "Finished." },
  writer: {
    steps: [{ call: { name: "save_artifact", args: { content: "# Report", name: "report.md" } } }],
    closing: "Wrote the report.",
  },
};

function scriptedModel(): ModelProvider {
  const baseline = new Map<string, number>();
  return async (effect) => {
    const script = SCRIPTS[effect.agentId]!;
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const results = prompt.filter((item) => item.kind === "tool-result");
    if (!baseline.has(effect.turnId)) baseline.set(effect.turnId, results.length);
    const index = results.length - baseline.get(effect.turnId)!;
    const step = script.steps[index];
    if (!step) return { output: [{ type: "text", text: script.closing }] };
    return {
      output: [
        ...(step.text ? [{ type: "text", text: step.text }] : []),
        ...(step.call
          ? [{ type: "tool-call", id: `call-${effect.turnId}-${index}`, name: step.call.name, args: step.call.args }]
          : []),
      ],
    };
  };
}

/** A push as the receiver got it. */
interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let held: Promise<void> = Promise.resolve();
let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let service: ToolServer;
let receiver: Server;
let receiverBase: string;
const received: Received[] = [];
/** Paths the receiver answers 503 to, this many more times each. */
const failing = new Map<string, number>();

beforeAll(async () => {
  receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (request.method === "GET" && path === "/files/notes.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      return void response.end("Notes from the bot.");
    }
    received.push({ path, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    const left = failing.get(path) ?? 0;
    if (left > 0) {
      failing.set(path, left - 1);
      return void response.writeHead(503).end();
    }
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const port = (receiver.address() as AddressInfo).port;
  receiverBase = `http://127.0.0.1:${port}`;
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: null,
    modelProvider: scriptedModel(),
    sandbox: { backend: "virtual" },
    sweepIntervalMs: 200,
    a2a: { push: { secret: SECRET, allowHosts: [`127.0.0.1:${port}`] } },
  });
  const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  service = await startToolServer({
    save: () => ({ saved: true }),
    wait: async () => {
      await held;
      return "waited";
    },
  });
  const support = Agent({ id: "support", name: "Support", description: "Answers questions." }).build();
  const guarded = Agent({ id: "guarded", name: "Guarded" })
    .tools(service.tool("save", { input: z.object({ note: z.string() }) }))
    .build();
  const slow = Agent({ id: "slow", name: "Slow" }).tools(service.tool("wait", { input: z.object({}) })).build();
  for (const agent of [support, guarded, slow]) {
    await client.agentManifests.save({ agent });
    await client.agents.put(agent.id, { manifest: agent.id });
  }
  const writer = Agent({ id: "writer", name: "Writer" }).instructions("Write.").build();
  await deploy(runtime.url, { ...runtime.headers(), "content-type": "application/json" }, writer, {
    name: "writer",
    runtime: { kind: "virtual" },
  });
  await setToolPolicy(runtime, [{ effect: "ask", tool: "save", agent: "guarded" }]);
}, 60_000);

afterAll(async () => {
  receiver?.closeAllConnections();
  await new Promise((resolve) => receiver?.close(resolve));
  await service?.close();
  await runtime?.close();
});

interface Call {
  agent?: string;
  subject?: string;
  extensions?: readonly string[] | null;
  traceparent?: string;
}

let ids = 0;
const next = (prefix: string) => `${prefix}-${++ids}`;

/** One JSON-RPC call straight to the Runtime, as the bot's service makes it. */
async function rpc(method: string, params: unknown, call: Call = {}) {
  const headers: Record<string, string> = {
    ...runtime.headers(),
    "content-type": "application/json",
    "A2A-Version": "1.0",
    "Nylorun-Subject": call.subject ?? "u:org:ada",
    "Nylorun-Scopes": "sessions:own",
  };
  const extensions = call.extensions === undefined ? ALL : call.extensions;
  if (extensions !== null) headers["A2A-Extensions"] = extensions.join(", ");
  if (call.traceparent) headers.traceparent = call.traceparent;
  const response = await fetch(`${runtime.url}/v1/a2a/agents/${call.agent ?? "support"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: next("rpc"), method, params }),
  });
  expect(response.status).toBe(200);
  return { headers: response.headers, body: (await response.json()) as any };
}

const message = (text: string, extra: Record<string, unknown> = {}) => ({
  messageId: next("m"),
  role: "ROLE_USER",
  parts: [{ text }],
  ...extra,
});

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(value).slice(0, 800)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Verifies a push as Standard Webhooks says, with nothing but the secret. */
function verify(push: Received): unknown {
  const id = String(push.headers["webhook-id"]);
  const timestamp = String(push.headers["webhook-timestamp"]);
  expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(300);
  const expected = createHmac("sha256", SECRET_KEY).update(`${id}.${timestamp}.${push.body}`).digest();
  const signatures = String(push.headers["webhook-signature"]).split(" ");
  expect(
    signatures.some((entry) => {
      const [version, value] = entry.split(",");
      const given = Buffer.from(value ?? "", "base64");
      return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
    })
  ).toBe(true);
  return JSON.parse(push.body);
}

const pushesTo = (path: string) => received.filter((push) => push.path === path);
const states = (path: string) =>
  pushesTo(path).flatMap((push) => {
    const body = JSON.parse(push.body);
    return body.statusUpdate ? [body.statusUpdate.status.state as string] : [];
  });

describe("the Agent Card", () => {
  it("lists the JSON-RPC interface, no streaming, push, and the five optional extensions", async () => {
    const response = await fetch(`${runtime.url}/v1/a2a/agents/support/card`, { headers: runtime.headers() });
    const card = await response.json();
    expect(card.supportedInterfaces).toEqual([
      { url: `${runtime.url}/v1/a2a/agents/support`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ]);
    expect(card.capabilities).toMatchObject({ streaming: false, pushNotifications: true, extendedAgentCard: false });
    expect(card.capabilities.extensions.map((e: { uri: string }) => e.uri)).toEqual(ALL);
    for (const extension of card.capabilities.extensions)
      expect(extension).toMatchObject({ required: false, params: { profile: "https://docs.nylorun.com/a2a/profile/v2" } });
  });
});

describe("extensions", () => {
  it("echoes the activated ones and leaves out the others' data", async () => {
    const both = await rpc("SendMessage", { message: message("Save it") }, {
      agent: "guarded",
      extensions: [A2A_EXTENSIONS.interactions, A2A_EXTENSIONS.files, "https://example.com/unknown/v1"],
    });
    expect(both.headers.get("a2a-extensions")).toBe(`${A2A_EXTENSIONS.interactions}, ${A2A_EXTENSIONS.files}`);
    const task = both.body.result.task;
    expect(task.status.message.metadata[A2A_EXTENSIONS.interactions]).toMatchObject({ kind: "approval" });
    const plain = await rpc("GetTask", { id: task.id }, { agent: "guarded", extensions: null });
    expect(plain.headers.get("a2a-extensions")).toBeNull();
    expect(plain.body.result.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
    expect(plain.body.result.status.message.metadata).toBeUndefined();
    expect(plain.body.result.status.message.parts).toEqual([{ text: "Approve save?" }]);
    await rpc("CancelTask", { id: task.id }, { agent: "guarded" });
  });

  it("strips by URI and parses the header", () => {
    expect([...parseExtensions(` ${A2A_EXTENSIONS.files},x, ${A2A_EXTENSIONS.effects}`)]).toEqual([
      A2A_EXTENSIONS.effects,
      A2A_EXTENSIONS.files,
    ]);
    const value = {
      metadata: { [A2A_EXTENSIONS.progress]: { steps: [] }, other: 1 },
      extensions: [A2A_EXTENSIONS.progress],
      parts: [{ data: { metadata: { [A2A_EXTENSIONS.progress]: "kept: the caller's own data" } } }],
    };
    expect(keepExtensions(value, new Set())).toEqual({
      metadata: { other: 1 },
      parts: [{ data: { metadata: { [A2A_EXTENSIONS.progress]: "kept: the caller's own data" } } }],
    });
  });
});

describe("push notifications", () => {
  it("POSTs each update signed with Standard Webhooks, the token, and telemetry at the end", async () => {
    const path = "/push/signed";
    const sent = await rpc(
      "SendMessage",
      {
        message: message("Hi"),
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: { url: `${receiverBase}${path}`, token: "tok-1" },
        },
      },
      { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` }
    );
    const task = sent.body.result.task;
    await until(() => states(path), (seen) => seen.includes("TASK_STATE_COMPLETED"));
    const pushes = pushesTo(path);
    const bodies = pushes.map(verify) as any[];
    for (const push of pushes) {
      expect(push.headers["content-type"]).toBe("application/json");
      expect(push.headers["x-a2a-notification-token"]).toBe("tok-1");
      expect(String(push.headers["webhook-id"])).toMatch(/^push_/);
    }
    const updates = bodies.filter((body) => body.statusUpdate).map((body) => body.statusUpdate);
    expect(updates[0]).toMatchObject({ taskId: task.id, contextId: task.contextId, status: { state: "TASK_STATE_WORKING" } });
    for (const update of updates) expect(update.status.timestamp).toEqual(expect.any(String));
    const terminal = updates.at(-1);
    expect(terminal.status.state).toBe("TASK_STATE_COMPLETED");
    expect(terminal.metadata[A2A_EXTENSIONS.telemetry]).toEqual({
      totals: { steps: expect.any(Number), tokens: expect.any(Number), costUsd: expect.any(Number) },
      traceId: TRACE_ID,
    });
    const output = bodies.find((body) => body.artifactUpdate);
    expect(output.artifactUpdate.artifact).toEqual({
      artifactId: "output",
      name: "output",
      parts: [{ text: "Hello from support." }],
    });
    // GetTask says the same, with the trace id the caller sent.
    const got = (await rpc("GetTask", { id: task.id })).body.result;
    expect(got.metadata[A2A_EXTENSIONS.telemetry].traceId).toBe(TRACE_ID);
  });

  it("retries a push the receiver did not take, with the same webhook-id", async () => {
    const path = "/push/flaky";
    failing.set(path, 2);
    await rpc("SendMessage", {
      message: message("Hi"),
      configuration: { returnImmediately: true, taskPushNotificationConfig: { url: `${receiverBase}${path}` } },
    });
    const counts = () => {
      const byId = new Map<string, number>();
      for (const push of pushesTo(path)) {
        const id = String(push.headers["webhook-id"]);
        byId.set(id, (byId.get(id) ?? 0) + 1);
      }
      return byId;
    };
    // The two pushes that failed come again (the sweep), each under its first webhook-id.
    await until(
      () => [...counts().values()],
      (seen) => seen.filter((count) => count === 2).length === 2 && states(path).includes("TASK_STATE_COMPLETED"),
      20_000
    );
    for (const push of pushesTo(path)) verify(push);
  });

  it("backs off, and drops a push past 24 hours", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(pushRetry(1, new Date(now).toISOString(), now)).toEqual({ retryInMs: 5_000 });
    expect(pushRetry(3, new Date(now).toISOString(), now)).toEqual({ retryInMs: 20_000 });
    expect(pushRetry(30, new Date(now).toISOString(), now)).toEqual({ retryInMs: 600_000 });
    expect(pushRetry(30, new Date(now - 24 * 3600_000 + 1_000).toISOString(), now)).toBe("drop");
  });

  it("serves the four config methods, scoped to the caller", async () => {
    const task = (await rpc("SendMessage", { message: message("Hi") })).body.result.task;
    const url = `${receiverBase}/push/methods`;
    const created = await rpc("CreateTaskPushNotificationConfig", { taskId: task.id, id: "c-1", url, token: "t" });
    expect(created.body.result).toEqual({ id: "c-1", taskId: task.id, url, token: "t" });
    await rpc("CreateTaskPushNotificationConfig", { taskId: task.id, id: "c-2", url });
    expect((await rpc("GetTaskPushNotificationConfig", { taskId: task.id, id: "c-2" })).body.result).toEqual({
      id: "c-2",
      taskId: task.id,
      url,
    });
    const first = (await rpc("ListTaskPushNotificationConfigs", { taskId: task.id, pageSize: 1 })).body.result;
    expect(first.configs.map((c: { id: string }) => c.id)).toEqual(["c-1"]);
    const second = (
      await rpc("ListTaskPushNotificationConfigs", { taskId: task.id, pageSize: 1, pageToken: first.nextPageToken })
    ).body.result;
    expect(second).toEqual({ configs: [expect.objectContaining({ id: "c-2" })], nextPageToken: "" });
    expect((await rpc("DeleteTaskPushNotificationConfig", { taskId: task.id, id: "c-1" })).body.result).toEqual({});
    expect((await rpc("GetTaskPushNotificationConfig", { taskId: task.id, id: "c-1" })).body.error.code).toBe(-32001);
    // Another subject's task is not found.
    const theirs = await rpc("GetTaskPushNotificationConfig", { taskId: task.id, id: "c-2" }, { subject: "u:org:bob" });
    expect(theirs.body.error.code).toBe(-32001);
    // A private host the Runtime may not reach is refused when the config is given.
    const refused = await rpc("CreateTaskPushNotificationConfig", { taskId: task.id, url: "http://10.1.2.3:8080/push" });
    expect(refused.body.error.code).toBe(-32602);
    // The task had ended: nothing was pushed for it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(pushesTo("/push/methods")).toEqual([]);
  });
});

describe("a follow-up to a busy context", () => {
  it("is queued and answered with the task that takes it; reject keeps CONTEXT_BUSY", async () => {
    let release!: () => void;
    held = new Promise((resolve) => (release = resolve));
    const contextId = next("ctx");
    const first = (
      await rpc("SendMessage", { message: message("Go", { contextId }), configuration: { returnImmediately: true } }, { agent: "slow" })
    ).body.result.task;
    expect(first.status.state).toBe("TASK_STATE_WORKING");
    const path = "/push/queued";
    const queued = (
      await rpc(
        "SendMessage",
        {
          message: message("And then this", { contextId }),
          configuration: { returnImmediately: true, taskPushNotificationConfig: { url: `${receiverBase}${path}` } },
        },
        { agent: "slow" }
      )
    ).body.result.task;
    expect(queued.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(queued.id).not.toBe(first.id);
    expect(queued.contextId).toBe(contextId);
    expect((await rpc("GetTask", { id: queued.id }, { agent: "slow" })).body.result.status.state).toBe(
      "TASK_STATE_SUBMITTED"
    );
    const rejected = await rpc(
      "SendMessage",
      { message: message("Not now", { contextId, metadata: { delivery: "reject" } }) },
      { agent: "slow" }
    );
    expect(rejected.body.error.code).toBe(-32004);
    expect(rejected.body.error.data[0].reason).toBe("CONTEXT_BUSY");
    release();
    const done = await until(
      async () => (await rpc("GetTask", { id: queued.id }, { agent: "slow" })).body.result,
      (task) => task.status.state === "TASK_STATE_COMPLETED"
    );
    expect(done.id).toBe(queued.id);
    expect(done.history[0].parts).toEqual([{ text: "And then this" }]);
    expect((await rpc("GetTask", { id: first.id }, { agent: "slow" })).body.result.status.state).toBe(
      "TASK_STATE_COMPLETED"
    );
    // The queued task's pushes name the id its caller knows, from WORKING to COMPLETED.
    await until(() => states(path), (seen) => seen.includes("TASK_STATE_COMPLETED"));
    const bodies = pushesTo(path).map(verify) as any[];
    expect(new Set(bodies.map((body) => (body.statusUpdate ?? body.artifactUpdate).taskId))).toEqual(new Set([queued.id]));
    expect(states(path)[0]).toBe("TASK_STATE_WORKING");
  });
});

describe("interactions over A2A", () => {
  const answer = (task: { id: string; contextId: string }, interactionId: string, approved: boolean) => ({
    message: {
      messageId: next("answer"),
      role: "ROLE_USER",
      taskId: task.id,
      contextId: task.contextId,
      parts: [{ data: { approved } }],
      extensions: [A2A_EXTENSIONS.interactions],
      metadata: { [A2A_EXTENSIONS.interactions]: { interactionId, approved } },
    },
  });

  it("shows an approval as AUTH_REQUIRED and takes the answer on the same task, as the caller", async () => {
    const calls = service.calls.length;
    const asked = (await rpc("SendMessage", { message: message("Save it") }, { agent: "guarded" })).body.result.task;
    expect(asked.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
    const open = asked.status.message.metadata[A2A_EXTENSIONS.interactions];
    expect(open).toEqual({
      interactionId: expect.any(String),
      kind: "approval",
      prompt: "Approve save?",
      detail: expect.objectContaining({ tool: "save" }),
    });
    expect(JSON.stringify(open)).not.toContain("hi");
    // Text never approves.
    const text = await rpc("SendMessage", { message: message("yes", { taskId: asked.id }) }, { agent: "guarded" });
    expect(text.body.error.code).toBe(-32004);
    // A wrong interaction id is refused.
    const wrong = await rpc("SendMessage", answer(asked, "eff_nope", true), { agent: "guarded" });
    expect(wrong.body.error.code).toBe(-32602);
    const params = answer(asked, open.interactionId, true);
    const done = (await rpc("SendMessage", params, { agent: "guarded" })).body.result.task;
    expect(done.id).toBe(asked.id);
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(service.calls.length).toBe(calls + 1);
    // A retried answer replays.
    expect((await rpc("SendMessage", params, { agent: "guarded" })).body.result.task.id).toBe(asked.id);
    // The Runtime recorded the caller as the approver.
    const sessionId = contextSessionId("u:org:ada", "guarded", asked.contextId);
    const items = (await (await fetch(`${runtime.url}/v1/sessions/${sessionId}/items`, { headers: runtime.headers() })).json()) as {
      items: { type: string; payload: any }[];
    };
    const completed = items.items.find((item) => item.type === "tool.completed" && item.payload.toolName === "save");
    expect(completed?.payload.policy).toMatchObject({ decision: "ask", approvedBy: expect.stringContaining("u:org:ada") });
  });

  it("denies with approved: false, and the call is never sent", async () => {
    const calls = service.calls.length;
    const asked = (await rpc("SendMessage", { message: message("Save it") }, { agent: "guarded" })).body.result.task;
    const open = asked.status.message.metadata[A2A_EXTENSIONS.interactions];
    const done = (await rpc("SendMessage", answer(asked, open.interactionId, false), { agent: "guarded" })).body.result
      .task;
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(service.calls.length).toBe(calls);
  });
});

describe("files", () => {
  it("answers the files a task wrote as url artifacts with files/v1, served only to the caller", async () => {
    const task = (await rpc("SendMessage", { message: message("Write it") }, { agent: "writer" })).body.result.task;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    const file = task.artifacts.find((artifact: { name: string }) => artifact.name === "report.md");
    expect(file.extensions).toEqual([A2A_EXTENSIONS.files]);
    expect(file.metadata[A2A_EXTENSIONS.files]).toEqual({
      kind: "file",
      path: "report.md",
      version: 1,
      size: 8,
      sha256: createHash("sha256").update("# Report").digest("hex"),
    });
    const [part] = file.parts;
    expect(part).toMatchObject({ mediaType: "text/markdown", filename: "report.md" });
    expect(part.url).toMatch(new RegExp(`^${runtime.url}/v1/a2a/files/[^/]+/versions/1$`));
    const as = (subject: string) =>
      fetch(part.url, {
        headers: { ...runtime.headers(), "Nylorun-Subject": subject, "Nylorun-Scopes": "sessions:own" },
      });
    const mine = await as("u:org:ada");
    expect(mine.status).toBe(200);
    expect(await mine.text()).toBe("# Report");
    expect((await as("u:org:bob")).status).toBe(404);
  });

  it("fetches url parts from hosts the Runtime allows, and refuses private ones it does not", async () => {
    const task = (
      await rpc("SendMessage", {
        message: {
          messageId: next("m"),
          role: "ROLE_USER",
          parts: [{ text: "Read this" }, { url: `${receiverBase}/files/notes.txt` }],
        },
      })
    ).body.result.task;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    const stored = await createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId }).artifacts.list({
      sessionId: contextSessionId("u:org:ada", "support", task.contextId),
    });
    expect(stored).toMatchObject([{ name: "notes.txt", contentType: "text/plain" }]);
    const refused = await rpc("SendMessage", {
      message: { messageId: next("m"), role: "ROLE_USER", parts: [{ url: "http://10.1.2.3:8080/x.txt" }] },
    });
    expect(refused.body.error.code).toBe(-32602);
  });
});

describe("the translator", () => {
  const turnId = "4f2c1a9e-0000-4000-8000-000000000000";
  let seq = 0;
  const event = (type: string, payload: unknown, extra: Partial<LiveEvent> = {}): LiveEvent =>
    ({
      schema: "nylorun.session-event/1",
      eventId: `e-${++seq}`,
      tenantId: "t",
      sessionId: "s",
      runId: null,
      turnId,
      incarnation: 0,
      epoch: 0,
      seq,
      cursor: `c-${seq}`,
      time: new Date(Date.UTC(2026, 9, 31, 12, 0, seq)).toISOString(),
      schemaVersion: 1,
      source: { kind: "loop", id: "x" },
      evidence: "observed",
      visibility: "public",
      retention: "full",
      type,
      payload,
      ...extra,
    }) as LiveEvent;
  const view = { contextId: "ctx", taskId: taskIdOf("ctx", turnId), baseUrl: "https://agents.example" };
  const plan = {
    steps: [
      { label: "Inspect wikis and toolchain", state: "done", note: "Node 22, pnpm 9" },
      { label: "Build in parts", state: "active" },
      { label: "x".repeat(200), state: "weird" },
    ],
  };

  it("sends plan.updated as progress/v1 on a WORKING update, and keeps the latest on the task", () => {
    const updates = updatesOf(event("plan.updated", plan), view) as any[];
    expect(updates).toHaveLength(1);
    const steps = updates[0].statusUpdate.metadata[A2A_EXTENSIONS.progress].steps;
    expect(updates[0].statusUpdate.status.state).toBe("TASK_STATE_WORKING");
    expect(steps[0]).toEqual({ label: "Inspect wikis and toolchain", state: "done", note: "Node 22, pnpm 9" });
    expect(steps[2]).toEqual({ label: "x".repeat(120), state: "pending" });
    const task = buildTask({
      contextId: "ctx",
      turnId,
      session: { status: "running", activeTurnId: turnId },
      events: [event("plan.updated", { steps: [{ label: "Old", state: "active" }] }), event("plan.updated", plan)],
    })!;
    expect(task.metadata![A2A_EXTENSIONS.progress]).toEqual({ steps });
  });

  it("marks an uncertain effect under effects/v1, and a connection ask as AUTH_REQUIRED", () => {
    const [uncertain] = updatesOf(event("effect.uncertain", { effectId: "eff_9" }), view) as any[];
    expect(uncertain.statusUpdate.metadata).toEqual({ [A2A_EXTENSIONS.effects]: { uncertain: "eff_9" } });
    const [connection] = updatesOf(
      event("turn.paused", {
        interactions: [
          {
            invocationId: "i",
            interaction: {
              id: "int_1",
              kind: "response",
              prompt: "Connect GitHub to go on",
              metadata: { kind: "connection", app: "github" },
            },
          },
        ],
      }),
      view
    ) as any[];
    expect(connection.statusUpdate.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
    expect(connection.statusUpdate.status.message.metadata[A2A_EXTENSIONS.interactions]).toEqual({
      interactionId: "int_1",
      kind: "connection",
      prompt: "Connect GitHub to go on",
      detail: { app: "github" },
    });
  });

  it("never shows tool calls, and ends with telemetry", () => {
    expect(updatesOf(event("tool.completed", { toolName: "bash", output: "secret" }), view)).toEqual([]);
    expect(updatesOf(event("delegation.started", { agent: { id: "a", path: "a" } }), view)).toEqual([]);
    const ended = updatesOf(
      event("turn.failed", { error: { code: "model.failed" }, totals: { steps: 3, tokens: 10, costUsd: 0.5 } }),
      { ...view, traceId: TRACE_ID }
    ) as any[];
    expect(ended[0].statusUpdate.status.state).toBe("TASK_STATE_FAILED");
    expect(ended[0].statusUpdate.metadata[A2A_EXTENSIONS.telemetry]).toEqual({
      totals: { steps: 3, tokens: 10, costUsd: 0.5 },
      traceId: TRACE_ID,
    });
  });
});
