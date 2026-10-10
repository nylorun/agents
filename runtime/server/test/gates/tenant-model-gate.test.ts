/**
 * P1.1 exit A: with the gates service, the loop never reads a model credential. A Tenant
 * opened with a gate never builds its own in-process gate (`tenantModelGate`, the only path in
 * the loop to `HostModelVault`), yet its vault-backed turns complete. Without one, it builds
 * exactly one.
 */
import { afterEach, expect, it, vi } from "vitest";
import { Agent, createClient } from "@nylorun/agents";
import { tenantModelGate } from "../../src/gates/in-process.js";
import { startTestTenant } from "../support/tenant.js";

vi.mock("../../src/gates/in-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/gates/in-process.js")>();
  return { ...actual, tenantModelGate: vi.fn(actual.tenantModelGate) };
});

const PROVIDER = "https://models.gate-test.invalid/v1";
const realFetch = globalThis.fetch;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(tenantModelGate).mockClear();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function turn(): Promise<{ status: string; providerCalls: number }> {
  let providerCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PROVIDER)) return realFetch(input, init);
      providerCalls++;
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${chunk({ role: "assistant", content: "hello" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const runtime = await startTestTenant({ useHostModel: true, modelCall: { retryBaseDelayMs: 1 } });
  closers.push(() => runtime.close());
  const configured = await realFetch(`${runtime.url}/v1/tenant/model`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({
      requestId: "model-1",
      idempotencyKey: "model-1",
      provider: "custom",
      model: "test-model",
      baseUrl: PROVIDER,
      auth: { type: "api_key", key: "gate-test-provider-key" },
    }),
  });
  expect(configured.status).toBe(200);
  const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  await client.saveAgent(Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build(), {
    implementationVersion: "dev",
  });
  const session = await client.createSession({ id: "s1", agentId: "bot", ownerUserId: "ada" });
  await session.input("hi", { idempotencyKey: "m1" });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await session.inspect();
    if (["completed", "failed", "cancelled", "uncertain"].includes(view.status))
      return { status: view.status, providerCalls };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("session did not settle");
}

it("never builds the in-process gate when the gates service serves the Tenant", async () => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
  expect(await turn()).toEqual({ status: "completed", providerCalls: 1 });
  expect(tenantModelGate).not.toHaveBeenCalled();
});

it("builds one in-process gate when nothing else serves the Tenant", async () => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "");
  expect(await turn()).toEqual({ status: "completed", providerCalls: 1 });
  expect(tenantModelGate).toHaveBeenCalledTimes(1);
});
