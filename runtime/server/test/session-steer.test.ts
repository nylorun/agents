/**
 * Steer (D85, Host feature `steer`): a message sent with `delivery: "steer"` while a session's
 * turn runs waits marked `steer`, and our engine takes it into the running turn before its next
 * step (the `inputs` effect): its `command.message` is written under the running turn, then
 * `queue.taken` with the step, and the next model call reads it after the tool results. A steer
 * the turn never takes (the model gave its final answer) starts the next turn like any queued
 * message; one to an idle session starts a turn at once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { OPTIONAL_HOST_FEATURES, PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "steer-app-key-aaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "18" };

type PromptItem = { kind?: string; role?: string; content?: { type: string; text?: string }[] };

/** What each model call saw: its user texts, and whether a tool result came before the last. */
const calls: { texts: string[]; kinds: string[] }[] = [];
const held = new Map<string, () => void>();
/**
 * `hold:<name>` waits until released, then calls a tool this agent doesn't have, so the turn has a
 * second step; `final:<name>` waits, then answers. Any call after a tool result answers with the
 * user texts it saw.
 */
const model: ModelProvider = async (effect, signal) => {
  const prompt = ((effect.input as { prompt?: PromptItem[] }).prompt ?? []) as PromptItem[];
  const texts = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])));
  calls.push({ texts, kinds: prompt.map((item) => (item.kind === "message" ? (item.role ?? "?") : (item.kind ?? "?"))) });
  if (prompt.some((item) => item.kind === "tool-result")) return { output: [{ type: "text", text: `saw ${texts.join(",")}` }] };
  const hold = texts.at(-1)?.match(/^(hold|final):(\w+)$/);
  if (hold) {
    await new Promise<void>((resolve, reject) => {
      held.set(hold[2]!, resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    if (hold[1] === "hold") return { output: [{ type: "tool-call", id: `call-${effect.turnId}`, name: "lookup", args: {} }] };
  }
  return { output: [{ type: "text", text: `done ${texts.length}` }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  await deploy(runtime.url, headers, Agent({ id: "steer", name: "Steer" }).instructions("Answer.").build(), {
    runtime: { kind: "none" } as never,
  });
});

afterAll(async () => {
  await runtime?.close();
});

let n = 0;
async function send(session: string, text: string, delivery?: "queue" | "steer"): Promise<{ status: number; body: any }> {
  n++;
  const response = await fetch(`${runtime.url}/v1/sessions/${session}/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "message",
      requestId: `r${n}`,
      idempotencyKey: `k${n}`,
      content: text,
      ...(delivery ? { delivery } : {}),
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function view(session: string): Promise<any> {
  return (await fetch(`${runtime.url}/v1/sessions/${session}`, { headers })).json();
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

const running = (hold: string) => until(async () => held.has(hold), (v) => v);
const settled = (session: string) =>
  until(() => view(session), (v) => v.activeTurnId === null && v.queuedMessages === 0 && v.status === "completed");

async function open(id: string) {
  const opened = await openSession(runtime.url, headers, id, { agent: "steer", ownerUserId: "ada" });
  expect(opened.status, await opened.clone().text()).toBe(200);
}

async function events(session: string): Promise<{ type: string; payload: any; turnId: string | null }[]> {
  const page = (await (await fetch(`${runtime.url}/v1/sessions/${session}/items?limit=200`, { headers })).json()) as {
    items: { type: string; payload: any; turnId: string | null }[];
  };
  return page.items;
}

describe("steer", () => {
  it("is a Host feature", () => {
    expect(OPTIONAL_HOST_FEATURES).toContain("steer");
  });

  it("joins the running turn before its next step, after the tool results", async () => {
    await open("s1");
    expect((await send("s1", "hold:s1")).body).toMatchObject({ status: "accepted" });
    await running("s1");
    const steered = await send("s1", "only the first three", "steer");
    expect(steered).toMatchObject({ status: 200, body: { status: "queued", position: 1, delivery: "steer" } });
    held.get("s1")!();
    await settled("s1");

    // The step after the tool call read the message, after the tool result.
    const last = calls.at(-1)!;
    expect(last.texts.slice(-2)).toEqual(["hold:s1", "only the first three"]);
    expect(last.kinds.lastIndexOf("tool-result")).toBeLessThan(last.kinds.lastIndexOf("user"));

    const log = await events("s1");
    const turns = new Set(log.filter((event) => event.type === "command.message").map((event) => event.turnId));
    expect(turns.size).toBe(1);
    const queued = log.find((event) => event.type === "message.queued");
    expect(queued?.payload).toMatchObject({ delivery: "steer", queuedMessageId: steered.body.queuedMessageId });
    const taken = log.find((event) => event.type === "queue.taken");
    expect(taken?.payload).toMatchObject({ queuedMessageIds: [steered.body.queuedMessageId], step: 2 });
    expect(taken?.turnId).toBe([...turns][0]);
    const message = log.find(
      (event) => event.type === "command.message" && event.payload.queuedMessageId === steered.body.queuedMessageId,
    );
    expect(message?.payload.content).toBe("only the first three");
    // The turn index counts it as the running turn's queued message.
    const turnId = [...turns][0]!;
    const turn = await withTestSessionStore(runtime, (store) =>
      store.tx((t) => t.turnOfQueuedMessage("s1", steered.body.queuedMessageId)),
    );
    expect(turn?.turnId).toBe(turnId);
  });

  it("journals each step's take, so a step takes nothing it didn't take the first time", async () => {
    const rows = await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => {
        const view = await t.get<{ activeTurnId: string | null }>("sessions", "s1");
        const log = await events("s1");
        const turnId = log.find((event) => event.type === "queue.taken")!.turnId!;
        expect(view?.activeTurnId).toBeNull();
        return t.effectsForTurn<{ request: { kind: string; effectId: string }; outcome?: { value: unknown } }>(
          "s1",
          turnId,
          ["completed"],
        );
      }),
    );
    const inputs = rows.filter((row) => row.request.kind === "inputs");
    expect(inputs.map((row) => row.request.effectId.split(":").slice(-2).join(":"))).toEqual(["step:2"]);
    expect((inputs[0]!.outcome!.value as { events: unknown[] }).events).toHaveLength(1);
  });

  it("starts the next turn when the turn takes no further step", async () => {
    await open("s2");
    await send("s2", "final:s2");
    await running("s2");
    const steered = await send("s2", "after the answer", "steer");
    expect(steered.body).toMatchObject({ status: "queued", delivery: "steer" });
    held.get("s2")!();
    await settled("s2");
    const log = await events("s2");
    const taken = log.find((event) => event.type === "queue.taken");
    expect(taken?.payload.step).toBeUndefined();
    const turns = new Set(log.filter((event) => event.type === "command.message").map((event) => event.turnId));
    expect(turns.size).toBe(2);
    expect(calls.at(-1)!.texts.at(-1)).toBe("after the answer");
  });

  it("leaves a queued message for the next turn", async () => {
    await open("s3");
    await send("s3", "hold:s3");
    await running("s3");
    const queued = await send("s3", "later", "queue");
    expect(queued.body).toMatchObject({ status: "queued", delivery: "queue" });
    held.get("s3")!();
    await settled("s3");
    const log = await events("s3");
    const turns = new Set(log.filter((event) => event.type === "command.message").map((event) => event.turnId));
    expect(turns.size).toBe(2);
    expect(log.find((event) => event.type === "queue.taken")?.payload.step).toBeUndefined();
  });

  it("starts a turn at once on an idle session", async () => {
    await open("s4");
    expect((await send("s4", "hello", "steer")).body).toMatchObject({ status: "accepted" });
    await settled("s4");
  });
});
