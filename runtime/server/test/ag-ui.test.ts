import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpAgent, getRunOutcome } from "@ag-ui/client";
import type { BaseEvent, Message } from "@ag-ui/core";
import { Agent, createClient } from "@nylorun/agents";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";
import type { ModelProvider } from "../src/core/provider.js";
import { sessionIdFor } from "../src/api/ag-ui/session-id.js";
import { startTestTenant } from "./support/tenant.js";
import { startToolServer, type ToolServer } from "./support/tool-server.js";

/**
 * Phase 0 and Phase 1 exit gates: an AG-UI client drives the handler against a Runtime,
 * through `toNodeListener` on `node:http`, inside a stub app server that authenticates the
 * person (`x-user`) and strips any `Nylorun-*` header its clients send. The handler calls the
 * Runtime as each person (`client.as`), so the Runtime enforces who owns which thread.
 */

const APP = "ag-ui-e2e-app-token-aaaaaaaaaaaa";

type Step = { text?: string; call?: { name: string; args: object } };
const SCRIPTS: Record<string, { steps: Step[]; closing: string }> = {
  shop: {
    steps: [
      { text: "Looking it up.", call: { name: "lookup", args: { orderId: "o-1" } } },
      {
        text: "Saving a note.",
        call: { name: "write", args: { path: "note.txt", content: "o-1" } },
      },
    ],
    closing: "All done.",
  },
  guarded: {
    steps: [{ call: { name: "save", args: { note: "hi" } } }],
    closing: "Saved.",
  },
  slow: {
    steps: [{ text: "Starting.", call: { name: "wait", args: {} } }],
    closing: "Finished.",
  },
};

/** Plays each agent's script, one step per model call within a turn. */
function scriptedModel(): ModelProvider {
  const baseline = new Map<string, number>();
  return async (effect) => {
    const script = SCRIPTS[effect.agentId]!;
    const prompt =
      (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const results = prompt.filter((item) => item.kind === "tool-result");
    if (!baseline.has(effect.turnId))
      baseline.set(effect.turnId, results.length);
    const index = results.length - baseline.get(effect.turnId)!;
    const step = script.steps[index];
    if (!step) return { output: [{ type: "text", text: script.closing }] };
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

/** The agents' HTTP tools, answered by the app's own service. */
function agents(service: ToolServer) {
  const shop = Agent({ id: "shop", name: "Shop" })
    .tools(
      service.tool("lookup", {
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
      })
    )
    .build();
  const guarded = Agent({ id: "guarded", name: "Guarded" })
    .tools(
      service.tool("save", {
        input: z.object({ note: z.string() }),
        output: z.object({ saved: z.literal(true) }),
        approval: "always",
      })
    )
    .build();
  const slow = Agent({ id: "slow", name: "Slow" })
    .tools(service.tool("wait", { input: z.object({}) }))
    .build();
  return [shop, guarded, slow];
}

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let service: ToolServer;
let server: Server;
let base: string;
let runtimeClient: ReturnType<typeof createClient>;

/** A person's thread session, as the Runtime names it. */
const sessionOf = sessionIdFor;

beforeAll(async () => {
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: null,
    sandbox: { backend: "virtual" },
    modelProvider: scriptedModel(),
  });
  // The handler opens sessions without naming a sandbox, so they get the Tenant default.
  const configured = await fetch(`${runtime.url}/v1/tenant/sandbox`, {
    method: "PUT",
    headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ default: "virtual" }),
  });
  if (!configured.ok) throw new Error(await configured.text());
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  service = await startToolServer({
    lookup: () => ({ status: "shipped" }),
    save: () => ({ saved: true }),
    wait: async () => {
      await held;
      return "waited";
    },
  });
  const built = agents(service);
  for (const agent of built) await client.saveAgent(agent, { implementationVersion: "dev" });
  const handler = createAgUiHandler({
    basePath: "/api/agui",
    agents: built,
    client,
    subject: (request) => request.headers.get("x-user") ?? undefined,
  });
  const listener = toNodeListener(handler);
  server = createServer((req, res) => {
    // The app server's rule: a client never names a subject or scopes itself.
    for (const name of Object.keys(req.headers))
      if (name.startsWith("nylorun-")) delete req.headers[name];
    listener(req, res);
  });
  runtimeClient = client;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agui`;
}, 60_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await service?.close();
  await runtime?.close();
});

function agentFor(agentId: string, user: string, threadId: string) {
  const agent = new HttpAgent({
    url: `${base}/${agentId}`,
    headers: { "x-user": user },
    threadId,
  });
  const seen: BaseEvent[] = [];
  agent.subscribe({ onEvent: ({ event }) => void seen.push(event) });
  return { agent, seen };
}

async function say(
  h: ReturnType<typeof agentFor>,
  text: string,
  id = crypto.randomUUID()
) {
  h.seen.length = 0;
  h.agent.addMessage({ id, role: "user", content: text });
  await h.agent.runAgent({ runId: crypto.randomUUID() });
  return [...h.seen];
}

const types = (events: readonly BaseEvent[]) => events.map((event) => event.type);

async function historyOf(agentId: string, user: string, threadId: string) {
  const response = await fetch(
    `${base}/${agentId}/threads/${threadId}/messages`,
    { headers: { "x-user": user } }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Message[];
}

/** Reads SSE frames: `id` and the parsed `data` of each event. */
async function* frames(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) yield { id, event: JSON.parse(data) as BaseEvent };
    }
  }
}

describe("AG-UI handler against the Runtime", () => {
  it("streams text between tool calls, HTTP tool and sandbox results, and reloads the same messages", async () => {
    const h = agentFor("shop", "ada", "t-shop");
    const events = await say(h, "Where is my order?");
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const live = h.agent.messages;
    expect(live.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(live[1]).toMatchObject({
      content: "Looking it up.",
      toolCalls: [{ function: { name: "lookup" } }],
    });
    expect(JSON.parse(String(live[2]!.content))).toEqual({ status: "shipped" });
    expect(live[5]).toMatchObject({ content: "All done." });

    const history = await historyOf("shop", "ada", "t-shop");
    expect(history.map((m) => [m.id, m.role])).toEqual(
      live.map((m) => [m.id, m.role])
    );
    expect(history[1]).toMatchObject({
      content: "Looking it up.",
      toolCalls: live[1]!.role === "assistant" ? live[1]!.toolCalls : [],
    });

    // Another person naming the same thread reaches a different, empty session.
    expect(await historyOf("shop", "bob", "t-shop")).toEqual([]);
    // And the Runtime itself refuses the other person the first one's session.
    const adaSession = sessionOf("ada", "shop", "t-shop");
    const asAda = await runtimeClient.as("ada").session(adaSession).inspect();
    expect(asAda.ownerUserId).toBe("ada");
    await expect(
      runtimeClient.as("bob").session(adaSession).inspect()
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runtimeClient.as("bob").session(adaSession).history()
    ).rejects.toMatchObject({ status: 404 });
  });

  it("acts for the person the app server signed in, whatever Nylorun-* headers the client sends", async () => {
    const h = agentFor("shop", "ada", "t-forged");
    await say(h, "Where is my order?");
    const forged = await fetch(`${base}/shop/threads/t-forged/messages`, {
      headers: {
        "x-user": "bob",
        "Nylorun-Subject": "ada",
        "Nylorun-Scopes": "sessions:own agents:write",
      },
    });
    expect(forged.status).toBe(200);
    expect(await forged.json()).toEqual([]);
    expect((await historyOf("shop", "ada", "t-forged")).length).toBeGreaterThan(0);
  });

  it("replays a retried message instead of starting a second turn", async () => {
    const id = crypto.randomUUID();
    const body = JSON.stringify({
      threadId: "t-retry",
      runId: "run-1",
      messages: [{ id, role: "user", content: "Where is my order?" }],
      tools: [],
      context: [],
    });
    const post = () =>
      fetch(`${base}/shop`, {
        method: "POST",
        headers: { "x-user": "ada", "content-type": "application/json" },
        body,
      });
    const first: string[] = [];
    for await (const { event } of frames(await post())) first.push(event.type);
    const second: string[] = [];
    for await (const { event } of frames(await post())) second.push(event.type);
    expect(second).toEqual(first);
    expect(first.at(-1)).toBe("RUN_FINISHED");
    const history = await historyOf("shop", "ada", "t-retry");
    expect(history.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("ends a run on approval with an interrupt naming the tool call, and resumes it", async () => {
    const h = agentFor("guarded", "ada", "t-guarded");
    const events = await say(h, "Save hi");
    const finished = events.at(-1)!;
    const outcome = getRunOutcome(finished as never) as {
      type: string;
      interrupts: { id: string; reason: string; toolCallId?: string; message?: string }[];
    };
    expect(outcome.type).toBe("interrupt");
    const [interrupt] = outcome.interrupts;
    const call = events.find((event) => event.type === "TOOL_CALL_START") as {
      toolCallId: string;
    };
    expect(interrupt).toMatchObject({
      reason: "tool_approval",
      message: "Approve save?",
      toolCallId: call.toolCallId,
    });

    h.seen.length = 0;
    await h.agent.runAgent({
      runId: crypto.randomUUID(),
      resume: [
        { interruptId: interrupt!.id, status: "resolved", payload: { approved: true } },
      ],
    });
    expect(types(h.seen)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const result = h.seen.find((event) => event.type === "TOOL_CALL_RESULT") as {
      toolCallId: string;
      content: string;
    };
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(JSON.parse(result.content)).toEqual({ saved: true });
    expect(h.agent.messages.at(-1)).toMatchObject({ content: "Saved." });

    const history = await historyOf("guarded", "ada", "t-guarded");
    expect(history.map((m) => m.id)).toEqual(h.agent.messages.map((m) => m.id));
  });

  it("reattaches after a dropped connection and sends the remaining events once", async () => {
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new AbortController();
    const response = await fetch(`${base}/slow`, {
      method: "POST",
      headers: { "x-user": "ada", "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "t-slow",
        runId: "run-slow",
        messages: [{ id: crypto.randomUUID(), role: "user", content: "go" }],
        tools: [],
        context: [],
      }),
      signal: reading.signal,
    });
    const before: string[] = [];
    let lastId: string | undefined;
    for await (const { id, event } of frames(response)) {
      before.push(event.type);
      if (id) lastId = id;
      if (event.type === "TOOL_CALL_END") break;
    }
    reading.abort();
    expect(lastId).toBeTruthy();
    release();

    const again = await fetch(`${base}/slow/threads/t-slow/events`, {
      headers: { "x-user": "ada", "last-event-id": lastId! },
    });
    expect(again.status).toBe(200);
    const after: string[] = [];
    let finalId: string | undefined;
    for await (const { id, event } of frames(again)) {
      after.push(event.type);
      if (id) finalId = id;
    }
    expect(before).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
    ]);
    expect(after).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);

    // Nothing follows the end of the run.
    const done = await fetch(`${base}/slow/threads/t-slow/events`, {
      headers: { "x-user": "ada", "last-event-id": finalId! },
    });
    expect(done.status).toBe(204);
  });

  it("cancels a thread's running turn", async () => {
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = agentFor("slow", "ada", "t-cancel");
    h.agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "go" });
    const running = h.agent.runAgent({ runId: crypto.randomUUID() });
    for (let i = 0; i < 400 && !h.seen.some((e) => e.type === "TOOL_CALL_END"); i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const cancelled = await fetch(`${base}/slow/threads/t-cancel/cancel`, {
      method: "POST",
      headers: { "x-user": "ada" },
    });
    expect(cancelled.status).toBe(204);
    await running;
    release();
    const outcome = getRunOutcome(h.seen.at(-1) as never) as { type: string };
    expect(outcome.type).toBe("cancelled");
  });
});
