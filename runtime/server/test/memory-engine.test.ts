/**
 * Agent memory through our engine (track T5, D72): an agent whose version sets `harness.memory`
 * is offered `memory` with Anthropic's schema and reads its memory index, pinned after the
 * instructions at the session's first turn. A call is served by the Runtime and versioned to the
 * turn; the next session's index shows it; `memory.<command>` is taken as the tool.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeSection } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";

const APP = "memory-app-key-aaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "17" };

type Prompt = { kind?: string; role?: string; content?: { type: string; text?: string }[] }[];
type Tool = { name: string; inputSchema: { properties: { command: { enum: string[] } } } };

/** Each call's prompt and tools; a message `call <name> <json>` calls tool `name` with the JSON. */
const calls: { prompt: Prompt; tools: Tool[] }[] = [];
const textOf = (item: Prompt[number] | undefined) =>
  (item?.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
const model: ModelProvider = async (effect) => {
  const input = effect.input as { tools?: Tool[]; prompt?: Prompt };
  const prompt = input.prompt ?? [];
  calls.push({ prompt, tools: input.tools ?? [] });
  if (prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "noted" }] };
  const call = textOf(prompt.filter((item) => item.role === "user" && item.kind === "message").at(-1)).match(/^call (\S+) (.*)$/s);
  if (call) return { output: [{ type: "tool-call", id: `c${calls.length}`, name: call[1], args: JSON.parse(call[2]!) }] };
  return { output: [{ type: "text", text: "ok" }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let n = 0;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  const bot = Agent({ id: "keeper", name: "Keeper" }).instructions("Help the team.").build();
  const none = { kind: "none" } as RuntimeSection;
  await deploy(runtime.url, headers, bot, { name: "keeper", runtime: none, memory: { instructions: "Keep release conventions." } });
  await deploy(runtime.url, headers, bot, { name: "reader", runtime: none, memory: { access: "read_only" } });
});

afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string): Promise<any> {
  return (await fetch(`${runtime.url}${path}`, { method, headers })).json();
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

async function open(id: string, agent: string) {
  const opened = await openSession(runtime.url, headers, id, { agent, ownerUserId: "ada" });
  expect(opened.status, await opened.clone().text()).toBe(200);
}

async function send(session: string, content: string): Promise<void> {
  n++;
  const response = await fetch(`${runtime.url}/v1/sessions/${session}/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "message", requestId: `r${n}`, idempotencyKey: `k${n}`, content }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await until(() => call("GET", `/v1/sessions/${session}`), (v) => v.activeTurnId === null && v.queuedMessages === 0);
}

const lastResult = () => JSON.stringify(calls.at(-1)!.prompt.at(-1));

describe("memory through our engine", () => {
  it("offers the tool with the rules and pins the index after the instructions", async () => {
    await open("m1", "keeper");
    await send("m1", "hello");
    const { prompt, tools } = calls.at(-1)!;
    expect(tools.find((tool) => tool.name === "memory")?.inputSchema.properties.command.enum).toContain("create");
    expect(textOf(prompt[0])).toContain("You have a persistent memory directory at /memories.");
    expect(textOf(prompt[0])).toContain("Keep release conventions.");
    expect(prompt[1]).toMatchObject({ kind: "context", role: "user" });
    expect(textOf(prompt[1])).toContain("Your memory directory (/memories) is empty.");
  });

  it("writes a memory the Runtime versions to the turn, and takes memory.<command> as the tool", async () => {
    const file = "---\ndescription: How we cut release branches\n---\nCut from release/x.y.";
    await send("m1", `call memory ${JSON.stringify({ command: "create", path: "/memories/conventions/release.md", file_text: file })}`);
    expect(lastResult()).toContain("File created successfully at: /memories/conventions/release.md");
    await send("m1", `call memory.str_replace ${JSON.stringify({ path: "/memories/conventions/release.md", old_str: "x.y", new_str: "<major>.<minor>" })}`);
    expect(lastResult()).toContain("The memory file has been edited.");
    const memory = await call("GET", `/v1/agents/keeper/memories/${encodeURIComponent("conventions/release.md")}`);
    expect(memory.content).toContain("release/<major>.<minor>");
    const versions = (await call("GET", "/v1/agents/keeper/memory_versions")).versions;
    expect(versions.map((v: any) => [v.operation, v.sessionId])).toEqual([
      ["str_replace", "m1"],
      ["create", "m1"],
    ]);
    // A call missing a parameter is answered by our engine and never reaches the Runtime.
    await send("m1", `call memory ${JSON.stringify({ command: "create", path: "/memories/x.md" })}`);
    expect(lastResult()).toContain("Error: create requires file_text.");
    expect((await call("GET", "/v1/agents/keeper/memories")).memories).toHaveLength(1);
  });

  it("keeps the session's pinned index, and shows the new memory to the next session", async () => {
    await send("m1", "again");
    expect(textOf(calls.at(-1)!.prompt[1])).toContain("is empty");
    await open("m2", "keeper");
    await send("m2", "hello");
    expect(textOf(calls.at(-1)!.prompt[1])).toContain("- /memories/conventions/release.md — How we cut release branches");
  });

  it("gives a read_only agent view only", async () => {
    await open("r1", "reader");
    await send("r1", "hello");
    expect(calls.at(-1)!.tools.find((tool) => tool.name === "memory")?.inputSchema.properties.command.enum).toEqual(["view"]);
  });
});
