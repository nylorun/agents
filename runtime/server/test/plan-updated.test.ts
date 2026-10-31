/**
 * `update_plan` (A2A profile v2, `progress/v1`): an agent whose manifest sets `harness.loop.plan`
 * keeps its plan with our engine's built-in tool. Our harness claims each call as a durable
 * `plan.updated` event (the whole plan, cut to its limits), which the Runtime records with the
 * harness as its writer and serves like any public event.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeSection } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";

const APP = "plan-app-key-aaaaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "18" };

/** Each call's tool names; a message `plan <json>` calls update_plan with it. */
const calls: { tools: string[] }[] = [];
const model: ModelProvider = async (effect) => {
  const input = effect.input as {
    tools?: { name: string }[];
    prompt?: { kind?: string; role?: string; content?: { type: string; text?: string }[] }[];
  };
  const prompt = input.prompt ?? [];
  calls.push({ tools: (input.tools ?? []).map((tool) => tool.name) });
  if (prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "planned" }] };
  const last = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])))
    .at(-1);
  const plan = last?.match(/^plan (.*)$/s)?.[1];
  if (plan) return { output: [{ type: "tool-call", id: `call-${calls.length}`, name: "update_plan", args: JSON.parse(plan) }] };
  return { output: [{ type: "text", text: "ok" }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let n = 0;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  const bot = Agent({ id: "planner", name: "Planner" }).instructions("Plan your work.").build();
  await deploy(runtime.url, headers, bot, { name: "planner", runtime: { kind: "none" } as RuntimeSection, loop: { plan: true } });
  await deploy(runtime.url, headers, bot, { name: "unplanned", id: "unplanned", runtime: { kind: "none" } as RuntimeSection });
});

afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string): Promise<any> {
  return (await fetch(`${runtime.url}${path}`, { method, headers })).json();
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

const items = async (session: string) =>
  (await call("GET", `/v1/sessions/${session}/items?limit=200`)).items as { type: string; payload: any; source: any; evidence: string; turnId: string }[];

describe("update_plan", () => {
  it("is offered only when the session's version sets harness.loop.plan", async () => {
    await open("p0", "unplanned");
    await send("p0", "hello");
    expect(calls.at(-1)!.tools).not.toContain("update_plan");
    await open("p1", "planner");
    await send("p1", "hello");
    expect(calls.at(-1)!.tools).toContain("update_plan");
  });

  it("records each call as a durable plan.updated with the whole plan, claimed by the harness", async () => {
    const first = { steps: [{ label: "Inspect", state: "active" }, { label: "Build", state: "pending" }] };
    await send("p1", `plan ${JSON.stringify(first)}`);
    const second = {
      steps: [
        { label: "Inspect", state: "done", note: "Node 22" },
        { label: "B".repeat(200), state: "active" },
      ],
    };
    await send("p1", `plan ${JSON.stringify(second)}`);
    const plans = (await items("p1")).filter((item) => item.type === "plan.updated");
    expect(plans).toHaveLength(2);
    expect(plans[0]!.payload).toEqual(first);
    expect(plans[1]!.payload).toEqual({
      steps: [
        { label: "Inspect", state: "done", note: "Node 22" },
        { label: `${"B".repeat(119)}…`, state: "active" },
      ],
    });
    expect(plans[1]!.evidence).toBe("claimed");
    expect(plans[1]!.source).toMatchObject({ kind: "harness" });
    const completed = (await items("p1")).filter((item) => item.type === "tool.completed").at(-1)!;
    expect(completed.payload).toMatchObject({ toolName: "update_plan", kind: "harness" });
    expect(plans[1]!.turnId).toBe(completed.turnId);
  });

  it("records nothing for a malformed plan, and the model hears why", async () => {
    await send("p1", `plan ${JSON.stringify({ steps: [{ label: "x", state: "finished" }] })}`);
    const plans = (await items("p1")).filter((item) => item.type === "plan.updated");
    expect(plans).toHaveLength(2);
  });
});
