/**
 * The model descriptor in `turn.start` (protocol 15): an agent's turn carries the model its
 * calls use when they name none — the Tenant's vault model, or the fixture model when the Tenant
 * uses it — so the harness decides how each file reaches it. A flow's turn, and a Tenant with no
 * model, carry none.
 */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { HARNESS_API_VERSION, memoryChannels, type HarnessChannel, type TurnStart } from "@nylorun/core/harness-api";
import { buildTurnStart, type SegmentStart } from "../../src/harness-api/start.js";
import { FIXTURE_DESCRIPTOR } from "../../src/model/descriptor.js";
import type { TenantContext } from "../../src/tenant/context.js";
import { boot, openSession, server, type Started } from "../host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function attach(runtime: Started): HarnessChannel {
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core, { name: "test" });
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  return channels.harness;
}

async function call(runtime: Started, method: string, path: string, body?: unknown, headers = server) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

/** A Runtime with a custom harness connected, session s1 on its Environment; the turn.start of its first turn. */
async function firstTurn(setup: (runtime: Started) => Promise<void> = async () => {}): Promise<TurnStart> {
  const runtime = await boot({ harness: "remote", vaultKek: Buffer.alloc(32, 9) });
  cleanups.push(() => runtime.close());
  await setup(runtime);
  const acme = attach(runtime);
  await acme.request("hello", { api: HARNESS_API_VERSION, name: "acme-mini", version: "0", features: {} });
  expect((await call(runtime, "PUT", "/v1/environments/env-acme", { kind: "none", harness: "acme-mini" })).status).toBe(200);
  await openSession(runtime, "seed");
  expect(
    (await call(runtime, "PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "bot", ownerUserId: "u", environment: "env-acme" }))
      .status
  ).toBe(200);
  const leased = acme.request("lease", {});
  const sent = await call(runtime, "POST", "/v1/sessions/s1/commands", {
    type: "message",
    requestId: "m1",
    idempotencyKey: "m1",
    content: "hi",
  });
  expect(sent.status).toBeLessThan(300);
  return ((await leased) as { input: TurnStart }).input;
}

const management = (runtime: Started) => runtime.managementHeaders() as Record<string, string>;

it("carries the vault model's descriptor, with the operator's additions", async () => {
  const input = await firstTurn(async (runtime) => {
    const put = await call(
      runtime,
      "PUT",
      "/v1/tenant/model",
      {
        requestId: "model-1",
        idempotencyKey: "model-1",
        provider: "custom",
        model: "vision-model",
        baseUrl: "https://provider.invalid/v1",
        settings: { inputs: ["image", "pdf"], contextWindow: 64_000, maxTokens: 2_000 },
        auth: { type: "api_key", key: "turn-start-provider-key" },
      },
      management(runtime)
    );
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  });
  expect(input.model).toEqual({
    provider: "custom",
    id: "vision-model",
    inputs: ["text", "image", "pdf"],
    contextWindow: 64_000,
    maxOutputTokens: 2_000,
    reasoning: false,
  });
});

it("carries no descriptor when the Tenant has no model", async () => {
  expect((await firstTurn()).model).toBeUndefined();
});

it("carries the fixture model's descriptor when the Tenant uses it", async () => {
  const input = await firstTurn(async (runtime) => {
    const seeded = await call(
      runtime,
      "PUT",
      "/v1/tenant/config/seed",
      { requestId: randomUUID(), fixtureModel: true },
      management(runtime)
    );
    expect(seeded.status).toBe(200);
  });
  expect(input.model).toEqual(FIXTURE_DESCRIPTOR);
});

it("leaves the descriptor out of a flow's turn.start", () => {
  const ctx = { flowLimits: {}, config: {} } as unknown as TenantContext;
  const segment = {
    current: {
      id: "s1",
      manifest: { kind: "workflow", id: "wf" },
      checkpoint: { version: 1 },
    },
    fixtureModel: false,
    limits: {},
    transcript: [],
    cursor: -1,
    outcomes: [],
    sandbox: { ownerId: "s1" },
    model: FIXTURE_DESCRIPTOR,
  } as unknown as SegmentStart;
  const start = buildTurnStart(ctx, segment);
  expect(start.engine).toBe("flow");
  expect(start).not.toHaveProperty("model");
});
