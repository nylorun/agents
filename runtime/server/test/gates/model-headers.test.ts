/**
 * #493: a custom model endpoint's headers. `settings.headers` go on every call, and
 * `settings.callHeaders` take their values from the calling Agent per call (its labels, its id,
 * the session's owner), for a gateway that attributes or budgets each call by org. A source with
 * no value sends no header. In process and through the gates service alike.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, createClient } from "@nylorun/agents";
import { deploy } from "../support/agents.js";
import { startTestTenant } from "../support/tenant.js";

const PROVIDER = "https://models.headers-test.invalid/v1";
const realFetch = globalThis.fetch;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Starts a Tenant whose model is a custom endpoint with `settings`, keeping each call's headers. */
async function tenant(settings: Record<string, unknown>) {
  const seen: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PROVIDER)) return realFetch(input, init);
      seen.push(new Headers(init?.headers));
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(`${chunk({ role: "assistant", content: "hello" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
  const runtime = await startTestTenant({ useHostModel: true, modelCall: { retryBaseDelayMs: 1 } });
  closers.push(() => runtime.close());
  const put = (body: Record<string, unknown>) =>
    realFetch(`${runtime.url}/v1/tenant/model`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({
        requestId: "model-1",
        idempotencyKey: `model-${JSON.stringify(body)}`,
        provider: "custom",
        model: "test-model",
        baseUrl: PROVIDER,
        auth: { type: "api_key", key: "headers-test-provider-key" },
        ...body,
      }),
    });
  expect((await put({ settings })).status).toBe(200);
  const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  let sessions = 0;
  return {
    seen,
    put,
    runtime,
    /** One turn on Agent `id`, made with `labels`, for `owner`; the headers of its model call. */
    async turn(id: string, labels: Record<string, string>, owner: string): Promise<Headers> {
      await deploy(runtime.url, runtime.headers(), Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build(), { id, labels });
      const before = seen.length;
      sessions += 1;
      const session = await client.createSession({ id: `s${sessions}`, agent: id, ownerUserId: owner });
      await session.input("hi", { idempotencyKey: `m${sessions}` });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const view = await session.inspect();
        if (["completed", "failed", "cancelled", "uncertain"].includes(view.status)) {
          expect(view.status).toBe("completed");
          expect(seen.length).toBe(before + 1);
          return seen.at(-1)!;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("session did not settle");
    },
  };
}

const SETTINGS = {
  headers: { "x-litellm-tags": "cell-1" },
  callHeaders: {
    "x-nylorun-org": { from: "agent.label", key: "org" },
    "x-nylorun-agent": { from: "agent.id" },
    "x-nylorun-person": { from: "session.owner" },
  },
};

describe.each([
  ["in process", ""],
  ["through the gates service", "http"],
])("a custom endpoint's headers, %s", (_name, gate) => {
  it("sends the static headers and the calling Agent's org, id and person", async () => {
    vi.stubEnv("NYLORUN_TEST_MODEL_GATE", gate);
    const { turn } = await tenant(SETTINGS);
    const headers = await turn("orgs/org_123/people/ada", { org: "org_123" }, "ada");
    expect(headers.get("authorization")).toBe("Bearer headers-test-provider-key");
    expect(headers.get("x-litellm-tags")).toBe("cell-1");
    expect(headers.get("x-nylorun-org")).toBe("org_123");
    expect(headers.get("x-nylorun-agent")).toBe("orgs/org_123/people/ada");
    expect(headers.get("x-nylorun-person")).toBe("ada");
  });

  it("sends no header whose source has no value: no org label, an installation session", async () => {
    vi.stubEnv("NYLORUN_TEST_MODEL_GATE", gate);
    const { turn } = await tenant(SETTINGS);
    const headers = await turn("unlabelled", { team: "x" }, "installation");
    expect(headers.get("x-litellm-tags")).toBe("cell-1");
    expect(headers.has("x-nylorun-org")).toBe(false);
    expect(headers.has("x-nylorun-person")).toBe(false);
    expect(headers.get("x-nylorun-agent")).toBe("unlabelled");
  });
});

describe("the model's headers", () => {
  it("are read back as settings, and refused for authorization, hop-by-hop and repeated names", async () => {
    vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "");
    const { put, runtime } = await tenant(SETTINGS);
    const view = await realFetch(`${runtime.url}/v1/tenant/model`, { headers: runtime.managementHeaders() }).then(
      (response) => response.json() as Promise<{ settings?: Record<string, unknown> }>,
    );
    expect(view.settings).toMatchObject(SETTINGS);
    for (const settings of [
      { headers: { Authorization: "Bearer other" } },
      { headers: { "proxy-authorization": "x" } },
      { headers: { connection: "close" } },
      { headers: { "content-type": "text/plain" } },
      { callHeaders: { "nylorun-org": { from: "agent.id" } } },
      { headers: { "x-org": "a" }, callHeaders: { "X-Org": { from: "agent.id" } } },
    ]) {
      const refused = await put({ settings });
      expect(refused.status, JSON.stringify(settings)).toBe(400);
    }
    expect((await put({ provider: "anthropic", model: "claude-sonnet-4-5", baseUrl: undefined, settings: SETTINGS })).status).toBe(
      400,
    );
  });
});
