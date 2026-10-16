/**
 * A queue per session (protocol 17, track T4, D76): a message sent while the session's turn runs
 * waits in its queue, unless it asks `delivery: "reject"` (`409 session_busy`), and the turn that
 * ends starts the next one with every queued message, each its own user message. A protocol 16
 * client's message is refused as before; a cancel ends the turn, not the queue; the queue holds at
 * most the Runtime limit `sessionQueuedMessages`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";
import { setLimits } from "./support/limits.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "queue-app-key-aaaaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "17" };

/** Each model call's user texts; a call whose prompt holds `hold` waits until it is released. */
const prompts: string[][] = [];
const held = new Map<string, () => void>();
const model: ModelProvider = async (effect, signal) => {
  const prompt = (effect.input as { prompt?: { role?: string; content?: { type: string; text?: string }[] }[] }).prompt ?? [];
  const texts = prompt
    .filter((item) => item.role === "user")
    .flatMap((item) => (item.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])));
  prompts.push(texts);
  const hold = texts.at(-1)?.match(/^hold:(\w+)$/)?.[1];
  if (hold)
    await new Promise<void>((resolve, reject) => {
      held.set(hold, resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { output: [{ type: "text", text: `done ${texts.length}` }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model });
  await deploy(runtime.url, headers, Agent({ id: "queue", name: "Queue" }).instructions("Answer.").build(), {
    runtime: { kind: "none" } as never,
  });
});

afterAll(async () => {
  await runtime?.close();
});

let n = 0;
async function send(
  session: string,
  text: string,
  options: { delivery?: "queue" | "reject"; protocol?: string } = {},
): Promise<{ status: number; body: any }> {
  n++;
  const response = await fetch(`${runtime.url}/v1/sessions/${session}/commands`, {
    method: "POST",
    headers: { ...headers, [PROTOCOL_HEADER]: options.protocol ?? "17" },
    body: JSON.stringify({
      type: "message",
      requestId: `r${n}`,
      idempotencyKey: `k${n}`,
      content: text,
      ...(options.delivery ? { delivery: options.delivery } : {}),
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

const running = (session: string, hold: string) =>
  until(async () => ({ session: await view(session), held: held.has(hold) }), (v) => v.held);
const settled = (session: string) =>
  until(() => view(session), (v) => v.activeTurnId === null && v.queuedMessages === 0 && v.status === "completed");

async function open(id: string) {
  const opened = await openSession(runtime.url, headers, id, { agent: "queue", ownerUserId: "ada" });
  expect(opened.status, await opened.clone().text()).toBe(200);
}

async function eventTypes(session: string): Promise<{ type: string; payload: any; turnId: string | null }[]> {
  const page = (await (await fetch(`${runtime.url}/v1/sessions/${session}/items?limit=200`, { headers })).json()) as {
    items: { type: string; payload: any; turnId: string | null }[];
  };
  return page.items;
}

describe("a message during a turn", () => {
  it("waits in the queue, and the next turn takes every queued message as its own", async () => {
    await open("q1");
    const first = await send("q1", "hold:q1");
    expect(first.body).toMatchObject({ status: "accepted" });
    await running("q1", "q1");
    const second = await send("q1", "second");
    const third = await send("q1", "third");
    expect(second).toMatchObject({ status: 200, body: { status: "queued", position: 1 } });
    expect(third).toMatchObject({ status: 200, body: { status: "queued", position: 2 } });
    expect((await view("q1")).queuedMessages).toBe(2);
    held.get("q1")!();
    await settled("q1");
    // The second turn's prompt ends with both messages, each its own user message.
    expect(prompts.at(-1)!.slice(-2)).toEqual(["second", "third"]);
    const events = await eventTypes("q1");
    const taken = events.find((event) => event.type === "queue.taken");
    expect(taken?.payload.queuedMessageIds).toEqual([second.body.queuedMessageId, third.body.queuedMessageId]);
    const messages = events.filter((event) => event.type === "command.message" && event.turnId === taken!.payload.turnId);
    expect(messages.map((event) => [event.payload.content, event.payload.queuedMessageId])).toEqual([
      ["second", second.body.queuedMessageId],
      ["third", third.body.queuedMessageId],
    ]);
    expect(events.filter((event) => event.type === "message.queued").map((event) => event.payload.position)).toEqual([1, 2]);
  });

  it("is refused with session_busy when it asks reject, or comes from a protocol 16 client", async () => {
    await open("q2");
    await send("q2", "hold:q2");
    await running("q2", "q2");
    const rejected = await send("q2", "no", { delivery: "reject" });
    expect(rejected).toMatchObject({ status: 409, body: { code: "session_busy" } });
    const old = await send("q2", "no", { protocol: "16" });
    expect(old).toMatchObject({ status: 409, body: { code: "session_busy" } });
    expect((await view("q2")).queuedMessages).toBe(0);
    held.get("q2")!();
    await settled("q2");
  });

  it("answers a retried queued message as it did the first time", async () => {
    await open("q3");
    await send("q3", "hold:q3");
    await running("q3", "q3");
    const body = { type: "message", requestId: "again", idempotencyKey: "again", content: "once" };
    const post = () =>
      fetch(`${runtime.url}/v1/sessions/q3/commands`, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json());
    const first = await post();
    expect(await post()).toEqual(first);
    expect((await view("q3")).queuedMessages).toBe(1);
    held.get("q3")!();
    await settled("q3");
  });
});

describe("the queue", () => {
  it("starts the next turn after a cancel", async () => {
    await open("q4");
    await send("q4", "hold:q4");
    await running("q4", "q4");
    await send("q4", "after cancel");
    const cancelled = await fetch(`${runtime.url}/v1/sessions/q4/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "cancel", requestId: "c", idempotencyKey: "c" }),
    });
    expect(cancelled.status).toBe(200);
    await settled("q4");
    expect(prompts.at(-1)!.at(-1)).toBe("after cancel");
  });

  it("holds at most sessionQueuedMessages, then answers 429 queue_full", async () => {
    await withTestSessionStore(runtime, (store) => setLimits(store, { sessionQueuedMessages: 1 }));
    try {
      await open("q5");
      await send("q5", "hold:q5");
      await running("q5", "q5");
      expect((await send("q5", "one")).body.status).toBe("queued");
      expect(await send("q5", "two")).toMatchObject({ status: 429, body: { code: "queue_full" } });
      held.get("q5")!();
      await settled("q5");
    } finally {
      await withTestSessionStore(runtime, (store) => setLimits(store, { sessionQueuedMessages: 100 }));
    }
  });

  it("is per session: another session of the Agent starts its turn at once", async () => {
    await open("q6");
    await open("q7");
    await send("q6", "hold:q6");
    await running("q6", "q6");
    expect((await send("q7", "beside")).body.status).toBe("accepted");
    await settled("q7");
    held.get("q6")!();
    await settled("q6");
  });
});
