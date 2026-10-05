/**
 * The model usage ledger (blueprint P1.3): whichever gate serves the call, every model call
 * that answers is recorded once, and `GET /v1/tenant/usage` totals the rows by scope. A call
 * that fails records nothing. Providers are faked by answering the custom endpoint's requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";

const APP = "model-usage-app-token-aaaaaaaaaa";
const PROVIDER = "https://models.usage.invalid/v1";
const realFetch = globalThis.fetch;

function answer(content: string) {
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

/** Answers provider requests with `reply`; every other request goes to the Runtime. */
function provider(reply: () => Response) {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PROVIDER)) return realFetch(input, init);
      calls++;
      return reply();
    }),
  );
  return { calls: () => calls };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function tenant() {
  const runtime = await startTestTenant({
    applicationKey: APP,
    useHostModel: true,
    modelCall: { retryBaseDelayMs: 1 },
  });
  closers.push(() => runtime.close());
  const configured = await realFetch(`${runtime.url}/v1/tenant/model`, {
    method: "PUT",
    headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "model-1",
      idempotencyKey: "model-1",
      provider: "custom",
      model: "test-model",
      baseUrl: PROVIDER,
      auth: { type: "api_key", key: "provider-key" },
    }),
  });
  expect(configured.status).toBe(200);
  const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  await client.saveAgent(Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build(), {
    implementationVersion: "dev",
  });
  const usage = async (query = "") => {
    const response = await realFetch(`${runtime.url}/v1/tenant/usage${query}`, { headers: runtime.managementHeaders() });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { client, usage };
}

async function settle(session: ReturnType<AgentsClient["session"]>) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await session.inspect();
    if (["completed", "failed", "cancelled", "uncertain"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("session did not settle");
}

describe.each([["in-process"], ["http"]] as const)("over the %s Model Gate", (transport) => {
  beforeEach(() => {
    vi.stubEnv("NYLORUN_TEST_MODEL_GATE", transport === "http" ? "http" : "");
  });

  it("records each answered call once and totals it by scope", async () => {
    const counter = provider(() => answer("hi"));
    const { client, usage } = await tenant();
    expect((await usage()).body).toEqual({ scope: "tenant", period: "total", calls: 0, tokens: 0, costUsd: 0 });

    const session = await client.createSession({ id: "s1", agentId: "bot", ownerUserId: "ada" });
    await session.input("hello", { idempotencyKey: "m1" });
    expect((await settle(session)).status).toBe("completed");
    await session.input("again", { idempotencyKey: "m2" });
    expect((await settle(session)).status).toBe("completed");
    expect(counter.calls()).toBe(2);

    // A custom endpoint is priced at $0: only token limits can stop it.
    expect((await usage()).body).toEqual({ scope: "tenant", period: "total", calls: 2, tokens: 30, costUsd: 0 });
    const month = await usage("?scope=agent&id=bot&period=month");
    expect(month.body).toMatchObject({ scope: "agent", id: "bot", period: "month", calls: 2, tokens: 30 });
    expect(month.body.since).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    expect((await usage("?scope=agent&id=other")).body).toMatchObject({ calls: 0 });
  });

  it("records nothing for a call that fails", async () => {
    provider(() => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));
    const { client, usage } = await tenant();
    const session = await client.createSession({ id: "s1", agentId: "bot", ownerUserId: "ada" });
    await session.input("hello", { idempotencyKey: "m1" });
    expect((await settle(session)).status).toBe("failed");
    expect((await usage()).body).toMatchObject({ calls: 0 });
  });
});

it("refuses an agent or turn total without an id, and an unknown scope", async () => {
  const { usage } = await tenant();
  expect((await usage("?scope=agent")).status).toBe(400);
  expect((await usage("?scope=session&id=s1")).status).toBe(400);
  expect((await usage("?period=week")).status).toBe(400);
});
