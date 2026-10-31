/**
 * `ListTasks` and `GetTask` from the turn index (A2A-E1 to E3): a context's session carries
 * `info.a2a`, so its turns are listable; `ListTasks` is the caller's own tasks with the Agent,
 * latest status change first, filtered by context, state and status time, paged with a token
 * bound to the query, counted; the change feed names each task's context and id.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/agents";
import type { ModelProvider } from "../../src/core/provider.js";
import { contextSessionId, taskIdOf } from "../../src/api/a2a/tasks.js";
import { deploy } from "../support/agents.js";
import { withTestSessionStore } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";
import { setToolPolicy } from "../support/tool-policy.js";
import { startToolServer, type ToolServer } from "../support/tool-server.js";

const APP = "a2a-list-app-key-aaaaaaaaaaaaaaaaa";

const model: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
  if (effect.agentId === "guarded" && !prompt.some((item) => item.kind === "tool-result"))
    return { output: [{ type: "tool-call", id: `call-${effect.turnId}`, name: "save", args: { note: "hi" } }] };
  return { output: [{ type: "text", text: "Done." }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let service: ToolServer;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  const headers = { ...runtime.headers(), "content-type": "application/json" };
  service = await startToolServer({ save: () => ({ saved: true }) });
  await deploy(runtime.url, headers, Agent({ id: "support", name: "Support" }).instructions("Answer.").build(), {
    runtime: { kind: "none" } as never,
  });
  await deploy(
    runtime.url,
    headers,
    Agent({ id: "guarded", name: "Guarded" })
      .instructions("Save.")
      .tools(service.tool("save", { input: z.object({ note: z.string() }) }))
      .build(),
  );
  await setToolPolicy(runtime, [{ effect: "ask", tool: "save", agent: "guarded" }]);
}, 60_000);

afterAll(async () => {
  await service?.close();
  await runtime?.close();
});

/** One JSON-RPC call to the Runtime's A2A route, as `subject`. */
async function rpc(method: string, params: unknown, options: { subject?: string; agent?: string } = {}) {
  const response = await fetch(`${runtime.url}/v1/a2a/agents/${options.agent ?? "support"}`, {
    method: "POST",
    headers: {
      ...runtime.headers(),
      "content-type": "application/json",
      "A2A-Version": "1.0",
      "Nylorun-Subject": options.subject ?? "a2a:acme",
      "Nylorun-Scopes": "sessions:own",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as any;
}

let messages = 0;
async function send(text: string, extra: Record<string, unknown> = {}, options: { subject?: string; agent?: string } = {}) {
  const body = await rpc(
    "SendMessage",
    { message: { messageId: `list-${++messages}`, role: "ROLE_USER", parts: [{ text }], ...extra } },
    options,
  );
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result.task as { id: string; contextId: string; status: { state: string; timestamp?: string } };
}

const list = async (params: Record<string, unknown>, options: { subject?: string; agent?: string } = {}) =>
  rpc("ListTasks", params, options);

let first: Awaited<ReturnType<typeof send>>;
let second: Awaited<ReturnType<typeof send>>;
let other: Awaited<ReturnType<typeof send>>;

describe("ListTasks", () => {
  beforeAll(async () => {
    first = await send("One", { contextId: "ctx-a" });
    second = await send("Two", { contextId: "ctx-a" });
    other = await send("Three", { contextId: "ctx-b" });
  });

  it("stores the context and the subject on the context's session", async () => {
    const sessionId = contextSessionId("a2a:acme", "support", "ctx-a");
    const session = await withTestSessionStore(runtime, (store) =>
      store.tx((t) => t.get<{ info?: unknown }>("sessions", sessionId)),
    );
    expect(session?.info).toEqual({ a2a: { contextId: "ctx-a", subject: "a2a:acme" } });
  });

  it("lists the caller's tasks, latest first, counted", async () => {
    const { result } = await list({});
    expect(result).toMatchObject({ nextPageToken: "", pageSize: 50, totalSize: 3 });
    expect(result.tasks.map((task: any) => task.id)).toEqual([other.id, second.id, first.id]);
    expect(result.tasks[0]).toEqual({
      id: other.id,
      contextId: "ctx-b",
      status: { state: "TASK_STATE_COMPLETED", timestamp: expect.any(String) },
    });
    // Status times only go back.
    const times = result.tasks.map((task: any) => task.status.timestamp);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("filters by context, state and status time", async () => {
    const byContext = (await list({ contextId: "ctx-a" })).result;
    expect(byContext.tasks.map((task: any) => task.id)).toEqual([second.id, first.id]);
    expect(byContext.totalSize).toBe(2);
    expect((await list({ contextId: "ctx-none" })).result).toEqual({ tasks: [], nextPageToken: "", pageSize: 50, totalSize: 0 });
    expect((await list({ status: "TASK_STATE_COMPLETED" })).result.totalSize).toBe(3);
    expect((await list({ status: "TASK_STATE_WORKING" })).result.totalSize).toBe(0);
    expect((await list({ status: "TASK_STATE_REJECTED" })).result.totalSize).toBe(0);
    const all = (await list({})).result.tasks;
    const since = (await list({ statusTimestampAfter: all[1].status.timestamp })).result;
    expect(since.tasks.map((task: any) => task.id)).toEqual([other.id, second.id]);
  });

  it("pages with a token bound to the query", async () => {
    const one = (await list({ pageSize: 1 })).result;
    expect(one).toMatchObject({ pageSize: 1, totalSize: 3 });
    expect(one.tasks.map((task: any) => task.id)).toEqual([other.id]);
    expect(one.nextPageToken).not.toBe("");
    const two = (await list({ pageSize: 1, pageToken: one.nextPageToken })).result;
    expect(two.tasks.map((task: any) => task.id)).toEqual([second.id]);
    const three = (await list({ pageSize: 1, pageToken: two.nextPageToken })).result;
    expect(three.tasks.map((task: any) => task.id)).toEqual([first.id]);
    expect(three.nextPageToken).toBe("");
    // Another query, or another subject, cannot read on with it.
    expect((await list({ pageSize: 1, pageToken: one.nextPageToken, contextId: "ctx-a" })).error.code).toBe(-32602);
    expect((await list({ pageToken: one.nextPageToken }, { subject: "a2a:beta" })).error.code).toBe(-32602);
    expect((await list({ pageToken: "nope" })).error.code).toBe(-32602);
  });

  it("refuses bad params", async () => {
    for (const params of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 1.5 },
      { status: "DONE" },
      { statusTimestampAfter: "yesterday" },
      { historyLength: -1 },
      { includeArtifacts: "yes" },
      { contextId: 7 },
    ]) {
      const body = await list(params);
      expect(body.error?.code, JSON.stringify(params)).toBe(-32602);
    }
  });

  it("adds history and artifacts only when asked", async () => {
    const [task] = (await list({ contextId: "ctx-b", historyLength: 10, includeArtifacts: true })).result.tasks;
    expect(task.history.map((message: any) => message.role)).toEqual(["ROLE_USER", "ROLE_AGENT"]);
    expect(task.artifacts).toEqual([{ artifactId: "output", name: "output", parts: [{ text: "Done." }] }]);
    const [lean] = (await list({ contextId: "ctx-b", historyLength: 1 })).result.tasks;
    expect(lean.history).toHaveLength(1);
    expect(lean).not.toHaveProperty("artifacts");
  });

  it("keeps each subject to its own tasks, and each Agent to its own", async () => {
    expect((await list({}, { subject: "a2a:beta" })).result).toMatchObject({ tasks: [], totalSize: 0 });
    const theirs = await send("Hi", {}, { subject: "a2a:beta" });
    expect((await list({}, { subject: "a2a:beta" })).result.tasks.map((task: any) => task.id)).toEqual([theirs.id]);
    expect((await list({})).result.totalSize).toBe(3);
    expect((await list({}, { agent: "guarded" })).result.totalSize).toBe(0);
  });

  it("shows a task waiting for approval as INPUT_REQUIRED with its question, then CANCELED", async () => {
    const asked = await send("Save it", { contextId: "ctx-g" }, { agent: "guarded" });
    expect(asked.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const [waiting] = (await list({ status: "TASK_STATE_INPUT_REQUIRED" }, { agent: "guarded" })).result.tasks;
    expect(waiting).toMatchObject({
      id: asked.id,
      status: { state: "TASK_STATE_INPUT_REQUIRED", message: { role: "ROLE_AGENT", parts: [{ text: "Approve save?" }] } },
    });
    await rpc("CancelTask", { id: asked.id }, { agent: "guarded" });
    const [cancelled] = (await list({}, { agent: "guarded" })).result.tasks;
    expect(cancelled).toMatchObject({ id: asked.id, status: { state: "TASK_STATE_CANCELED" } });
  });
});

describe("a context opened before info.a2a", () => {
  it("gets it with its next message, and its tasks from then on are listed", async () => {
    const sessionId = contextSessionId("a2a:old", "support", "ctx-old");
    const opened = await fetch(`${runtime.url}/v1/sessions/${sessionId}`, {
      method: "PUT",
      headers: { ...runtime.headers(), "content-type": "application/json" },
      body: JSON.stringify({ requestId: "old", agent: "support", ownerUserId: "a2a:old" }),
    });
    expect(opened.status).toBe(200);
    const task = await send("Again", { contextId: "ctx-old" }, { subject: "a2a:old" });
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect((await list({}, { subject: "a2a:old" })).result.tasks.map((listed: any) => listed.id)).toEqual([task.id]);
  });
});

describe("GetTask and the change feed", () => {
  it("reads one task from its turn, and a task of another context or subject is not found", async () => {
    const got = (await rpc("GetTask", { id: first.id })).result;
    expect(got).toMatchObject({ id: first.id, contextId: "ctx-a", status: { state: "TASK_STATE_COMPLETED" } });
    expect(got.history.map((message: any) => message.parts[0].text)).toEqual(["One", "Done."]);
    // A later turn of the context: read from its own first event to its end, nothing before.
    const later = (await rpc("GetTask", { id: second.id })).result;
    expect(later).toMatchObject({ id: second.id, status: { state: "TASK_STATE_COMPLETED" } });
    expect(later.history.map((message: any) => message.parts[0].text)).toEqual(["Two", "Done."]);
    expect((await rpc("GetTask", { id: first.id }, { subject: "a2a:beta" })).error.code).toBe(-32001);
    const turnId = first.id.split(".").at(-1)!;
    expect((await rpc("GetTask", { id: taskIdOf("ctx-b", turnId) })).error.code).toBe(-32001);
  });

  it("names each turn's A2A context and task", async () => {
    const turnId = first.id.split(".").at(-1)!;
    // The feed shows a change once every older transaction on the server has ended.
    let turns: any[] = [];
    for (let attempt = 0; attempt < 400 && !turns.some((turn) => turn.turnId === turnId); attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 25));
      const response = await fetch(`${runtime.url}/v1/turns?limit=500`, { headers: runtime.headers() });
      turns = ((await response.json()) as { turns: any[] }).turns;
    }
    expect(turns.find((turn) => turn.turnId === turnId)).toMatchObject({
      sessionId: contextSessionId("a2a:acme", "support", "ctx-a"),
      agentId: "support",
      status: "completed",
      a2a: { contextId: "ctx-a", taskId: first.id },
    });
  });
});
