/**
 * `request_connection` (A2A profile v2, `interactions/v1` kind `connection`): an agent whose
 * manifest sets `harness.loop.connections` asks for an app to be connected. The turn pauses on a
 * `response` interaction whose metadata says `kind: "connection"`, carried in the session's waits;
 * `respond` with `{ connected: true }` (or anything else) goes on, and the model reads the answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeSection } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";

const APP = "conn-app-key-aaaaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "18" };

/** Each call's tool names and the last tool result's text; `connect <app>` calls request_connection. */
const calls: { tools: string[] }[] = [];
const results: string[] = [];
const model: ModelProvider = async (effect) => {
  const input = effect.input as {
    tools?: { name: string }[];
    prompt?: { kind?: string; role?: string; content?: { type: string; text?: string }[] }[];
  };
  const prompt = input.prompt ?? [];
  calls.push({ tools: (input.tools ?? []).map((tool) => tool.name) });
  if (prompt.at(-1)?.kind === "tool-result") {
    results.push(JSON.stringify(prompt.at(-1)));
    return { output: [{ type: "text", text: "done" }] };
  }
  const last = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])))
    .at(-1);
  const app = last?.match(/^connect (.*)$/s)?.[1];
  if (app)
    return {
      output: [{ type: "tool-call", id: `call-${calls.length}`, name: "request_connection", args: { app, reason: "To open the pull request." } }],
    };
  return { output: [{ type: "text", text: "ok" }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let n = 0;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  const bot = Agent({ id: "connector", name: "Connector" }).instructions("Do the work.").build();
  await deploy(runtime.url, headers, bot, { name: "connector", runtime: { kind: "none" } as RuntimeSection, loop: { connections: true } });
  await deploy(runtime.url, headers, bot, { name: "plain-conn", id: "plain-conn", runtime: { kind: "none" } as RuntimeSection });
});

afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${runtime.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function command(session: string, body: Record<string, unknown>) {
  n++;
  const sent = await call("POST", `/v1/sessions/${session}/commands`, { requestId: `r${n}`, idempotencyKey: `k${n}`, ...body });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return until(
    async () => (await call("GET", `/v1/sessions/${session}`)).body,
    (view) => view.status === "paused" || (view.activeTurnId === null && view.queuedMessages === 0),
  );
}

async function open(id: string, agent: string) {
  const opened = await openSession(runtime.url, headers, id, { agent, ownerUserId: "ada" });
  expect(opened.status, await opened.clone().text()).toBe(200);
}

describe("request_connection", () => {
  it("is offered only when the session's version sets harness.loop.connections", async () => {
    await open("c0", "plain-conn");
    await command("c0", { type: "message", content: "hello" });
    expect(calls.at(-1)!.tools).not.toContain("request_connection");
    await open("c1", "connector");
    await command("c1", { type: "message", content: "hello" });
    expect(calls.at(-1)!.tools).toContain("request_connection");
  });

  it("pauses on a connection interaction in the session's waits, and goes on with the answer", async () => {
    const paused = await command("c1", { type: "message", content: "connect GitHub" });
    expect(paused.status).toBe("paused");
    expect(paused.waits).toHaveLength(1);
    const wait = paused.waits[0];
    expect(wait.status).toBe("interaction");
    expect(wait.interaction).toMatchObject({
      kind: "response",
      prompt: "Connect GitHub: To open the pull request.",
      metadata: { kind: "connection", app: "GitHub", reason: "To open the pull request." },
    });
    const done = await command("c1", { type: "respond", interactionId: wait.interaction.id, value: { connected: true } });
    expect(done.status).toBe("completed");
    expect(results.at(-1)).toContain("Connected: GitHub");

    const again = await command("c1", { type: "message", content: "connect Linear" });
    expect(again.status).toBe("paused");
    const declined = await command("c1", { type: "respond", interactionId: again.waits[0].interaction.id, value: "later" });
    expect(declined.status).toBe("completed");
    expect(results.at(-1)).toContain("Not connected: Linear");
  });
});
