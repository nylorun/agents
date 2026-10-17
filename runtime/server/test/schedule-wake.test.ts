/**
 * `schedule_wake` (track T4, D77): an agent whose manifest sets `runtime.selfWake` books its own
 * session's next turn. The Runtime serves the call (a `runtime` effect) in its own transaction:
 * one booking per session, a new one replacing it, bounded by the Tenant's limits; the booked turn
 * starts with the note as its message, as the session's own (`cause.kind: "self"`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { RuntimeSection } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import { triggerTimerKey, wakeIdOf } from "../src/tenant/triggers.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "wake-app-key-aaaaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "17" };

/** Each call's tool names and last user text; a message `book <json>` calls schedule_wake with it. */
const calls: { tools: string[]; last: string | undefined }[] = [];
const results: unknown[] = [];
const model: ModelProvider = async (effect) => {
  const input = effect.input as {
    tools?: { name: string }[];
    prompt?: { kind?: string; role?: string; content?: { type: string; text?: string }[] }[];
  };
  const prompt = input.prompt ?? [];
  const last = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])))
    .at(-1);
  calls.push({ tools: (input.tools ?? []).map((tool) => tool.name), last });
  const toolResults = prompt.filter((item) => item.kind === "tool-result");
  if (toolResults.length > 0 && prompt.at(-1)?.kind === "tool-result") {
    results.push(toolResults.at(-1));
    return { output: [{ type: "text", text: "booked" }] };
  }
  const book = last?.match(/^book (.*)$/s)?.[1];
  if (book) return { output: [{ type: "tool-call", id: `call-${calls.length}`, name: "schedule_wake", args: JSON.parse(book) }] };
  return { output: [{ type: "text", text: "ok" }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let n = 0;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  const bot = Agent({ id: "waker", name: "Waker" }).instructions("Keep watch.").build();
  await deploy(runtime.url, headers, bot, { name: "waker", runtime: { kind: "none", selfWake: true } as RuntimeSection });
  await deploy(runtime.url, headers, bot, { name: "plain", id: "plain", runtime: { kind: "none" } as RuntimeSection });
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

const booking = (agentId: string, sessionId: string) =>
  withTestSessionStore(runtime, (store) => store.tx((t) => t.agentTrigger(agentId, wakeIdOf(sessionId))));

async function open(id: string, agent: string) {
  const opened = await openSession(runtime.url, headers, id, { agent, ownerUserId: "ada" });
  expect(opened.status, await opened.clone().text()).toBe(200);
}

describe("schedule_wake", () => {
  it("is offered only when the session's version sets selfWake", async () => {
    await open("w0", "plain");
    await send("w0", "hello");
    expect(calls.at(-1)!.tools).not.toContain("schedule_wake");
    await open("w1", "waker");
    await send("w1", "hello");
    expect(calls.at(-1)!.tools).toContain("schedule_wake");
  });

  it("books the session's next turn, which starts with the note as the session's own message", async () => {
    await send("w1", `book ${JSON.stringify({ in: "2h", note: "Check the deploy again." })}`);
    const row = await booking("waker", "w1");
    expect(row).toMatchObject({ kind: "wake", status: "active", sessionId: "w1", note: "Check the deploy again." });
    const ahead = Date.parse(row!.nextFireAt!) - Date.now();
    expect(ahead).toBeGreaterThan(7_100_000);
    expect(ahead).toBeLessThanOrEqual(7_200_000);
    expect((await call("GET", "/v1/agents/waker")).nextWakeAt).toBe(row!.nextFireAt);
    const items = (await call("GET", "/v1/sessions/w1/items?limit=200")).items as { type: string; payload: any }[];
    expect(items.find((item) => item.type === "wake.booked")?.payload).toMatchObject({ note: "Check the deploy again.", replaced: false });
    expect(JSON.stringify(results.at(-1))).toContain(row!.nextFireAt!);

    // Due now: it fires once, on the session that booked it, and is gone.
    await withTestSessionStore(runtime, (store) =>
      store.tx((t) => t.putAgentTrigger({ ...row!, nextFireAt: new Date(Date.now() - 1_000).toISOString() })),
    );
    await runtime.handle.worker!.fire!(triggerTimerKey("waker", wakeIdOf("w1")));
    await until(() => call("GET", "/v1/sessions/w1"), (v) => v.activeTurnId === null && v.queuedMessages === 0);
    expect(calls.at(-1)!.last).toBe("Check the deploy again.");
    expect(await booking("waker", "w1")).toBeUndefined();
    const [run] = (await call("GET", "/v1/agents/waker/runs")).runs;
    expect(run).toMatchObject({ kind: "wake", triggerId: "wake:w1", status: "started", sessionId: "w1" });
    const after = (await call("GET", "/v1/sessions/w1/items?limit=200")).items as { type: string; payload: any }[];
    const message = after.filter((item) => item.type === "command.message").at(-1);
    expect(message?.payload).toMatchObject({ content: "Check the deploy again.", cause: { kind: "self", triggerId: "wake:w1", runId: run.id } });
  });

  it("keeps one booking per session: a new one replaces it, and cancel removes it", async () => {
    await send("w1", `book ${JSON.stringify({ in: "1d", note: "first" })}`);
    await send("w1", `book ${JSON.stringify({ at: new Date(Date.now() + 3 * 3_600_000).toISOString(), note: "second" })}`);
    expect(await booking("waker", "w1")).toMatchObject({ note: "second" });
    expect(JSON.stringify(results.at(-1))).toContain('\\"replaced\\":true');
    await send("w1", `book ${JSON.stringify({ cancel: true })}`);
    expect(await booking("waker", "w1")).toBeUndefined();
  });

  it("refuses a wake too soon, too far ahead, or with no note, and books nothing", async () => {
    await send("w1", `book ${JSON.stringify({ in: "10s", note: "soon" })}`);
    expect(JSON.stringify(results.at(-1))).toContain("triggerMinIntervalMs");
    await send("w1", `book ${JSON.stringify({ in: "90d", note: "later" })}`);
    expect(JSON.stringify(results.at(-1))).toContain("wakeMaxAheadMs");
    expect(await booking("waker", "w1")).toBeUndefined();
  });
});
