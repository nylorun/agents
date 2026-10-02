/**
 * Hard caps (blueprint P1.3): a runaway loop stops at its cap. The provider always answers with
 * a tool call, and the agent's one tool always succeeds, so only the turn's token cap ends the
 * turn: it fails with `model.budget_exhausted`, having overspent by at most one call. Runs
 * through both Model Gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, createClient, tool, type AgentsClient } from "@nylorun/agents";
import { serveAgents } from "./support/endpoint.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "model-budget-app-token-aaaaaaaaa";
const PROVIDER = "https://models.budget.invalid/v1";
const realFetch = globalThis.fetch;
const PER_CALL = 120;

/** A provider that calls the first tool it is offered, every time. */
function runaway() {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PROVIDER)) return realFetch(input, init);
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: { function: { name: string } }[] };
      const name = body.tools?.[0]?.function.name ?? "missing";
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      return new Response(
        chunk(
          {
            role: "assistant",
            tool_calls: [
              { index: 0, id: `call-${calls}`, type: "function", function: { name, arguments: "{}" } },
            ],
          },
          null,
        ) +
          chunk({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 20, total_tokens: PER_CALL }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  return { calls: () => calls };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const close of closers.splice(0).reverse()) await close();
});

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

  it("stops a runaway loop at the turn's token cap", { timeout: 30_000 }, async () => {
    const provider = runaway();
    const runtime = await startTestTenant({
      applicationKey: APP,
      useHostModel: true,
      modelCall: { retryBaseDelayMs: 1 },
    });
    closers.push(() => runtime.close());
    const headers = { ...runtime.headers(), "content-type": "application/json" };
    const put = async (path: string, body: unknown) => {
      const response = await realFetch(`${runtime.url}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    await put("/v1/tenant/model", {
      requestId: "model-1",
      idempotencyKey: "model-1",
      provider: "custom",
      model: "test-model",
      baseUrl: PROVIDER,
      auth: { type: "api_key", key: "provider-key" },
    });
    await put("/v1/tenant/budgets", { requestId: "b1", budgets: [{ scope: "turn", limitTokens: 500 }] });

    const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
    let runs = 0;
    const agent = Agent({ id: "looper", name: "Looper" })
      .instructions("Keep going.")
      .use({
        id: "loop",
        tools: [
          tool({
            name: "again",
            input: z.object({}),
            output: z.object({ ok: z.literal(true) }),
            async run() {
              runs += 1;
              return { ok: true as const };
            },
          }),
        ],
      })
      .build();
    const served = serveAgents({ agents: [agent], application: client, implementationVersion: "dev" });
    closers.push(() => served.close());
    await served.ready;

    const session = await client.createSession({ id: "s1", agentId: "looper", ownerUserId: "ada" });
    await session.input("go", { idempotencyKey: "m1" });
    const view = await settle(session);
    expect(view.status).toBe("failed");
    const { items } = await session.history();
    const payload = (type: string) => items.find((item) => item.type === type)?.payload as any;
    expect(payload("model.failed")).toMatchObject({ code: "budget_exhausted", retryable: false });
    expect(payload("turn.failed").error).toEqual({
      code: "model.budget_exhausted",
      message: "The turn's cap of 500 tokens is reached (600 used); raise it with PUT /v1/tenant/budgets",
    });

    // 4 calls (480 tokens) stay under 500, the 5th overspends by less than one call, the 6th is
    // refused before reaching the provider.
    expect(provider.calls()).toBe(5);
    expect(runs).toBe(5);
    const usage = (await (
      await realFetch(`${runtime.url}/v1/tenant/usage?scope=agent&id=looper`, { headers: runtime.headers() })
    ).json()) as { tokens: number; calls: number };
    expect(usage).toMatchObject({ calls: 5, tokens: 5 * PER_CALL });
    expect(usage.tokens - 500).toBeLessThan(PER_CALL);
  });
});
