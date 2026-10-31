/**
 * A session's own model (Host feature `session-model`): `PUT /v1/sessions/{id}/model` chooses one
 * of a connected provider's models for that session's turns. The Model Gate calls it, the
 * Tenant's model stays as it was, and another session keeps the Tenant's. It changes only
 * between turns, names a connected provider, and `DELETE` gives the session the Tenant's again.
 */
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";
import { deploy } from "./support/agents.js";
import { startTestTenant } from "./support/tenant.js";

const PROVIDER = "https://models.session-model.invalid/v1";
const realFetch = globalThis.fetch;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The models the provider was called with, in order; `hold` keeps each call open until released. */
function stubProvider(hold?: Promise<void>): string[] {
  const called: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PROVIDER)) return realFetch(input, init);
      called.push((JSON.parse(String(init?.body)) as { model: string }).model);
      await hold;
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${chunk({ role: "assistant", content: "hello" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  return called;
}

async function boot() {
  const runtime = await startTestTenant({ useHostModel: true, modelCall: { retryBaseDelayMs: 1 } });
  closers.push(() => runtime.close());
  const call = async (method: string, path: string, body?: unknown, headers = runtime.headers()) => {
    const response = await realFetch(`${runtime.url}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
  };
  const management = runtime.managementHeaders() as Record<string, string>;
  // Two connected providers: OpenAI, then the custom endpoint, which is the Tenant's model.
  for (const [key, model] of [
    ["openai", { provider: "openai", model: "gpt-4o-mini", auth: { type: "api_key", key: "session-model-openai-key" } }],
    [
      "custom",
      {
        provider: "custom",
        model: "tenant-model",
        baseUrl: PROVIDER,
        auth: { type: "api_key", key: "session-model-custom-key" },
      },
    ],
  ] as const) {
    const put = await call("PUT", "/v1/tenant/model", { requestId: key, idempotencyKey: key, ...model }, management);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  await deploy(runtime.url, runtime.headers(), Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build());
  for (const id of ["s1", "s2"])
    expect((await call("PUT", `/v1/sessions/${id}`, { requestId: id, agent: "bot", ownerUserId: "ada" })).status).toBe(200);
  const turn = async (id: string, key: string) => {
    const sent = await call("POST", `/v1/sessions/${id}/commands`, {
      type: "message",
      requestId: key,
      idempotencyKey: key,
      content: "hi",
    });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  };
  const settled = async (id: string) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const view = await call("GET", `/v1/sessions/${id}`);
      if (["completed", "failed", "cancelled", "uncertain"].includes(view.body.status)) return view.body.status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`session ${id} did not settle`);
  };
  return { runtime, call, management, turn, settled };
}

it("calls the session's own model, and leaves the Tenant's and other sessions' as they were", async () => {
  const called = stubProvider();
  const { call, management, turn, settled } = await boot();
  expect((await call("GET", "/v1/sessions/s1/model")).body).toEqual({
    configured: true,
    source: "tenant",
    provider: "custom",
    model: "tenant-model",
    baseUrl: PROVIDER,
  });
  const chosen = await call("PUT", "/v1/sessions/s1/model", { provider: "custom", model: "session-model" });
  expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
  expect(chosen.body).toEqual({
    configured: true,
    source: "session",
    provider: "custom",
    model: "session-model",
    baseUrl: PROVIDER,
    choice: { provider: "custom", model: "session-model" },
  });

  await turn("s1", "m1");
  expect(await settled("s1")).toBe("completed");
  await turn("s2", "m2");
  expect(await settled("s2")).toBe("completed");
  expect(called).toEqual(["session-model", "tenant-model"]);

  const tenant = await call("GET", "/v1/tenant/model", undefined, management);
  expect(tenant.body).toMatchObject({ provider: "custom", model: "tenant-model" });
  const usage = await call("GET", "/v1/sessions/s1/calls/model");
  expect(JSON.stringify(usage.body)).toContain("session-model");

  // Cleared, the session's next turn uses the Tenant's model again.
  const cleared = await call("DELETE", "/v1/sessions/s1/model");
  expect(cleared.body).toEqual({
    configured: true,
    source: "tenant",
    provider: "custom",
    model: "tenant-model",
    baseUrl: PROVIDER,
  });
  await turn("s1", "m3");
  expect(await settled("s1")).toBe("completed");
  expect(called.at(-1)).toBe("tenant-model");
});

it("chooses only a connected provider's model, and one its catalog lists", async () => {
  stubProvider();
  const { call } = await boot();
  const missing = await call("PUT", "/v1/sessions/s1/model", { provider: "anthropic", model: "claude-sonnet-4-5" });
  expect(missing.status).toBe(422);
  expect(missing.body.code).toBe("request_rejected");
  const unknown = await call("PUT", "/v1/sessions/s1/model", { provider: "openai", model: "no-such-model" });
  expect(unknown.status).toBe(422);
  const invalid = await call("PUT", "/v1/sessions/s1/model", { provider: "openai" });
  expect(invalid.status).toBe(400);
  const openai = await call("PUT", "/v1/sessions/s1/model", { provider: "openai", model: "gpt-4o-mini" });
  expect(openai.status, JSON.stringify(openai.body)).toBe(200);
  expect(openai.body).toMatchObject({ source: "session", provider: "openai", model: "gpt-4o-mini" });
  expect((await call("GET", "/v1/sessions/s2/model")).body).toMatchObject({ source: "tenant", provider: "custom" });
  expect((await call("GET", "/v1/sessions/nope/model")).status).toBe(404);
});

it("refuses a change while the session's turn runs", async () => {
  let release!: () => void;
  stubProvider(new Promise<void>((resolve) => (release = resolve)));
  const { call, turn, settled } = await boot();
  await turn("s1", "m1");
  let busy: { status: number; body: any } | undefined;
  for (let attempt = 0; attempt < 400 && busy?.status !== 409; attempt += 1) {
    busy = await call("PUT", "/v1/sessions/s1/model", { provider: "custom", model: "session-model" });
    if (busy.status !== 409) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(busy?.status).toBe(409);
  expect(busy?.body.code).toBe("session_busy");
  release();
  expect(await settled("s1")).toBe("completed");
  expect((await call("PUT", "/v1/sessions/s1/model", { provider: "custom", model: "session-model" })).status).toBe(200);
});

it("starts a new session on the model its Agent's version names, when the Tenant can use it (agent-model)", async () => {
  const called = stubProvider();
  const { runtime, call, turn, settled } = await boot();
  const bot = Agent({ id: "coder", name: "Coder" }).instructions("Code.").build();
  await deploy(runtime.url, runtime.headers(), bot, { name: "coder", model: "custom/agent-model" });
  // A provider that is not connected, and a model the catalog does not list: the Tenant's model.
  await deploy(runtime.url, runtime.headers(), bot, { name: "unconnected", id: "unconnected", model: "anthropic/claude-sonnet-4-5" });
  await deploy(runtime.url, runtime.headers(), bot, { name: "unlisted", id: "unlisted", model: "openai/no-such-model" });
  for (const [id, agent] of [["c1", "coder"], ["c2", "unconnected"], ["c3", "unlisted"]])
    expect((await call("PUT", `/v1/sessions/${id}`, { requestId: id, agent, ownerUserId: "ada" })).status).toBe(200);

  expect((await call("GET", "/v1/sessions/c1/model")).body).toMatchObject({
    source: "session",
    provider: "custom",
    model: "agent-model",
    choice: { provider: "custom", model: "agent-model" },
  });
  for (const id of ["c2", "c3"])
    expect((await call("GET", `/v1/sessions/${id}/model`)).body).toMatchObject({ source: "tenant", model: "tenant-model" });

  await turn("c1", "a1");
  expect(await settled("c1")).toBe("completed");
  await turn("c2", "a2");
  expect(await settled("c2")).toBe("completed");
  expect(called).toEqual(["agent-model", "tenant-model"]);

  // An explicit choice still overrides it, and clearing it gives the Tenant's model.
  const chosen = await call("PUT", "/v1/sessions/c1/model", { provider: "custom", model: "chosen-model" });
  expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
  await turn("c1", "a3");
  expect(await settled("c1")).toBe("completed");
  expect(called.at(-1)).toBe("chosen-model");
  expect((await call("DELETE", "/v1/sessions/c1/model")).body).toMatchObject({ source: "tenant" });
  // An existing session is found again as it is: no model put back.
  expect((await call("PUT", "/v1/sessions/c1", { requestId: "c1", agent: "coder", ownerUserId: "ada" })).status).toBe(200);
  expect((await call("GET", "/v1/sessions/c1/model")).body).toMatchObject({ source: "tenant" });
});
