/**
 * Track T5's exit test in process (`scripts/t5-exit.mjs` runs it on a Compose Tenant): the hourly
 * Agent from T4 writes a memory in one fire and reads it in the next, with an upgrade in between,
 * and the memory's version names its session and trigger run.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeSection } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { triggerTimerKey } from "../src/tenant/triggers.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy } from "./support/agents.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "memory-exit-key-aaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "17" };
const PATH = "/memories/facts/release-day.md";
const FILE = "---\ntype: Fact\ndescription: Which day the team releases\n---\nWe release on Thursdays.";

type Prompt = { kind?: string; role?: string; content?: { type: string; text?: string }[] }[];
const textOf = (item: Prompt[number] | undefined) =>
  (item?.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
/** A message `call <name> <json>` calls tool `name`; then it answers with the tool's result. */
const model: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: Prompt }).prompt ?? [];
  if (prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: `result: ${textOf(prompt.at(-1))}` }] };
  const call = textOf(prompt.filter((item) => item.kind === "message" && item.role === "user").at(-1)).match(/^call (\S+) (.*)$/s);
  if (call) return { output: [{ type: "tool-call", id: "c1", name: call[1], args: JSON.parse(call[2]!) }] };
  return { output: [{ type: "text", text: "ok" }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
const bot = Agent({ id: "keeper", name: "Keeper" }).instructions("Do what each message asks.").build();
const keeper = (prompt: string) =>
  deploy(runtime.url, headers, bot, {
    name: "keeper",
    memory: { instructions: "Keep the team's release facts." },
    runtime: { kind: "none", triggers: { tick: { schedule: "0 * * * *", session: "notes", prompt } } } as RuntimeSection,
  });

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
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

/** Makes the hourly trigger due, fires it as the execution would, and waits for its turn. */
async function fire(): Promise<any> {
  const due = new Date(Date.now() - 1_000).toISOString();
  await withTestSessionStore(runtime, (store) =>
    store.tx(async (t) => {
      const row = (await t.agentTrigger("keeper", "tick"))!;
      await t.putAgentTrigger({ ...row, status: "active", pausedReason: null, nextFireAt: due });
    }),
  );
  await runtime.handle.worker!.fire!(triggerTimerKey("keeper", "tick"));
  await until(() => call("GET", "/v1/sessions/notes"), (v) => v.activeTurnId === null && v.queuedMessages === 0);
  return (await call("GET", "/v1/agents/keeper/runs?limit=10")).runs.find((run: any) => run.dueAt === due);
}

it("writes a memory in one fire and reads it in the next, with an upgrade in between", async () => {
  await keeper(`call memory ${JSON.stringify({ command: "create", path: PATH, file_text: FILE })}`);
  const first = await fire();
  expect(first).toMatchObject({ status: "started", sessionId: "notes" });
  const memory = await call("GET", `/v1/agents/keeper/memories/${encodeURIComponent("facts/release-day.md")}`);
  expect(memory.content).toBe(FILE);
  const [version] = (await call("GET", "/v1/agents/keeper/memory_versions")).versions;
  expect(version).toMatchObject({ operation: "create", sessionId: "notes", triggerRunId: first.id, actor: "agent:keeper@1" });

  // The upgrade: a new version, which the tracking Agent moves to.
  await keeper(`call memory ${JSON.stringify({ command: "view", path: PATH })}`);
  expect((await call("GET", "/v1/agents/keeper")).resolvedVersion).toBe(2);
  const second = await fire();
  expect(second).toMatchObject({ status: "started", sessionId: "notes" });
  expect((await call("GET", "/v1/sessions/notes")).manifest).toEqual({ name: "keeper", version: 2 });
  const items = (await call("GET", "/v1/sessions/notes/items?limit=500")).items as { type: string; payload: any }[];
  const at = items.findIndex((item) => item.type === "command.message" && item.payload?.cause?.runId === second.id);
  expect(at).toBeGreaterThan(0);
  expect(JSON.stringify(items.slice(at))).toContain("We release on Thursdays.");
  expect((await call("GET", "/v1/agents/keeper/memory_versions")).versions).toHaveLength(1);
});
