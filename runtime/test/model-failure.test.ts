/**
 * Model Calls P0 (design §6): a provider failure is a known outcome, not a lost call. The
 * turn retries, then fails cleanly with `model.<code>`, and the session takes the next
 * message. Providers are faked by answering the custom endpoint's requests.
 */
import { afterEach, expect, it, vi } from "vitest";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import { parseTranscriptEvent, type LiveEvent } from "@nylorun/core/contracts";
import { startTestTenant } from "./support/tenant.js";

const APP = "model-failure-app-token-aaaaaaaa";
const PROVIDER = "https://models.test.invalid/v1";
const realFetch = globalThis.fetch;

type Reply = (body: Record<string, unknown>) => Response | Promise<Response>;

function sse(content: string) {
  return new Response(
    `data: ${JSON.stringify({
      id: "r",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\ndata: ${JSON.stringify({
      id: "r",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const error = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers });

/** Answers provider requests with `reply`; every other request goes to the Runtime. */
function provider(reply: Reply) {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PROVIDER)) return realFetch(input, init);
      calls++;
      return reply(JSON.parse(String(init?.body ?? "{}")));
    }),
  );
  return { calls: () => calls };
}

async function tenant(idleTimeoutMs = 5_000) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    useHostModel: true,
    modelCall: { retryBaseDelayMs: 1, idleTimeoutMs },
  });
  const response = await realFetch(`${runtime.url}/v1/tenant/model`, {
    method: "PUT",
    headers: { ...runtime.headers(), "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "model-1",
      idempotencyKey: "model-1",
      provider: "custom",
      model: "test-model",
      baseUrl: PROVIDER,
      auth: { type: "api_key", key: "provider-key" },
    }),
  });
  expect(response.status).toBe(200);
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  await client.saveAgent(Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build(), {
    implementationVersion: "dev",
  });
  return { runtime, client };
}

async function settle(session: ReturnType<AgentsClient["session"]>) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await session.inspect();
    if (["completed", "failed", "cancelled", "uncertain"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("session did not settle");
}

const ofType = (items: LiveEvent[], type: string) =>
  items.filter((item) => item.type === type).map((item) => item.payload as any);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function run(reply: Reply, idleTimeoutMs?: number) {
  const counter = provider(reply);
  const { runtime, client } = await tenant(idleTimeoutMs);
  closers.push(() => runtime.close());
  const session = await client.createSession({ id: "s1", agentId: "bot", ownerUserId: "ada" });
  await session.input("hello", { idempotencyKey: "m1" });
  const view = await settle(session);
  const { items } = await session.history();
  return { view, items, session, calls: counter.calls };
}

it("retries a rate-limited call and completes the turn without an uncertain effect", async () => {
  let n = 0;
  const { view, items, calls } = await run(() =>
    ++n <= 2 ? error(429, "Rate limit reached", { "retry-after-ms": "1" }) : sse("answer"),
  );
  expect(view.status).toBe("completed");
  expect(calls()).toBe(3);
  expect(ofType(items, "effect.uncertain")).toEqual([]);
  const [message] = ofType(items, "message.assistant");
  expect(message).toMatchObject({
    text: "answer",
    model: { provider: "custom", model: "test-model" },
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  expect(parseTranscriptEvent(items.find((i) => i.type === "message.assistant")!)).toBeDefined();
});

it("fails the turn with model.overloaded and accepts the next message", async () => {
  let healthy = false;
  const { view, items, session } = await run(() =>
    healthy
      ? sse("recovered")
      : error(503, "The server is overloaded", { "retry-after-ms": "1" }),
  );
  expect(view.status).toBe("failed");
  expect(ofType(items, "turn.failed")[0]).toMatchObject({
    error: { code: "model.overloaded" },
  });
  expect(ofType(items, "model.failed")[0]).toMatchObject({
    code: "overloaded",
    retryable: true,
    invocationId: expect.any(String),
  });
  expect(ofType(items, "effect.uncertain")).toEqual([]);

  healthy = true;
  await session.input("again", { idempotencyKey: "m2" });
  expect((await settle(session)).status).toBe("completed");
});

it("classifies a llama.cpp context overflow", async () => {
  const { view, items } = await run(() =>
    error(400, "the request exceeds the available context size, try increasing it"),
  );
  expect(view.status).toBe("failed");
  expect(ofType(items, "turn.failed")[0]).toMatchObject({
    error: { code: "model.context_overflow" },
  });
});

it("fails with model.auth and names where to fix the credential", async () => {
  const { items } = await run(() => error(401, "Incorrect API key provided"));
  const failed = ofType(items, "turn.failed")[0];
  expect(failed.error.code).toBe("model.auth");
  expect(failed.error.message).toContain("Model Settings");
});

it("times out an idle stream, retries it, then fails with model.timeout", async () => {
  const { items, calls } = await run(
    () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      }),
    100,
  );
  expect(ofType(items, "turn.failed")[0]).toMatchObject({
    error: { code: "model.timeout" },
  });
  expect(calls()).toBe(3);
});

it("records nothing as a model failure when the turn is cancelled during the call", async () => {
  provider(
    () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const { runtime, client } = await tenant();
  closers.push(() => runtime.close());
  const session = await client.createSession({ id: "s1", agentId: "bot", ownerUserId: "ada" });
  await session.input("hello", { idempotencyKey: "m1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await session.cancel({ idempotencyKey: "c1" });
  expect((await settle(session)).status).toBe("cancelled");
  const { items } = await session.history();
  expect(ofType(items, "model.failed")).toEqual([]);
});
