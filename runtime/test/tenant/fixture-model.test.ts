/**
 * The Tenant-level fixture model (`tenant/model-setting.ts`): `fixtureModel: true` through
 * `PUT /v1/tenant/config/seed` makes that Tenant's model calls use the Runtime's fixture
 * model; another Tenant on the same Host keeps its own model path.
 */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { TenantStatusSchema } from "@nylorun/core/contracts";
import { Agent, tool } from "@nylorun/core/define";
import type { ModelProvider } from "../../src/core/provider.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import { TenantWorkers } from "../../src/tenant/worker.js";
import { startTestTenant } from "../support/tenant.js";
import { until } from "../host/execution-support.js";

type Started = Awaited<ReturnType<typeof startTestTenant>>;

const open: Started[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const runtime of open.splice(0).reverse())
    await runtime.close().catch(() => undefined);
  for (const stop of stops.splice(0)) await stop();
});

const orders = Agent({ id: "orders", name: "Orders" })
  .use({
    id: "orders",
    tools: [
      tool({
        name: "lookup_order",
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        async run() {
          return { status: "shipped" };
        },
      }),
    ],
  })
  .build();

async function seed(runtime: Started, body: Record<string, unknown>) {
  const response = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtime.headers(),
    body: JSON.stringify({ requestId: randomUUID(), ...body }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { applied: string[]; kept: string[] };
}

async function turn(runtime: Started) {
  const headers = runtime.headers();
  expect(
    (
      await fetch(`${runtime.url}/v1/agents/orders`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          requestId: "put-orders",
          manifest: orders.manifest,
          implementationVersion: "dev",
        }),
      })
    ).ok
  ).toBe(true);
  expect(
    (
      await fetch(`${runtime.url}/v1/sessions/s1`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ requestId: "session-s1", agentId: "orders", ownerUserId: "u" }),
      })
    ).ok
  ).toBe(true);
  expect(
    (
      await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "message",
          requestId: "msg-1",
          idempotencyKey: "msg-1",
          content: "Where is my order?",
        }),
      })
    ).ok
  ).toBe(true);
}

async function items(runtime: Started) {
  const body = (await (
    await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: runtime.headers() })
  ).json()) as { items: { type: string; payload?: Record<string, unknown> }[] };
  return body.items;
}

async function modelCheck(runtime: Started): Promise<boolean> {
  const response = await fetch(`${runtime.url}/v1/tenant`, { headers: runtime.headers() });
  return TenantStatusSchema.parse(await response.json()).checks.model;
}

it("advertises the tenant-fixture-model Host feature", () => {
  expect(HOST_PROTOCOL.features).toContain("tenant-fixture-model");
});

it("uses the fixture model for the seeded Tenant only; another Tenant on the Host keeps its model", async () => {
  // One Host: one execution and one registry serve both Tenants.
  const execution = new MemoryExecution({ sweepIntervalMs: 60_000 });
  const workers = new TenantWorkers();
  await execution.start(workers.handlers);
  stops.push(() => execution.stop());
  let normalCalls = 0;
  const normal: ModelProvider = async () => {
    normalCalls += 1;
    return { output: [{ type: "text", text: "from the normal model" }] };
  };
  const fixtureTenant = await startTestTenant({
    modelProvider: normal,
    execution: { execution, workers },
  });
  open.push(fixtureTenant);
  const otherTenant = await startTestTenant({
    modelProvider: normal,
    execution: { execution, workers },
  });
  open.push(otherTenant);

  expect(await seed(fixtureTenant, { fixtureModel: true })).toEqual({
    applied: ["model.fixture"],
    kept: [],
  });
  // Insert-if-absent, like every seeded setting.
  expect(await seed(fixtureTenant, { fixtureModel: true })).toEqual({
    applied: [],
    kept: ["model.fixture"],
  });

  await turn(fixtureTenant);
  await turn(otherTenant);

  // The fixture model asks for the demo order through the agent's tool.
  const pending = await until(
    () => items(fixtureTenant),
    (list) => list.some((item) => item.type === "action.pending"),
    "the fixture model's tool call"
  );
  expect(pending.find((item) => item.type === "action.pending")?.payload).toMatchObject({
    kind: "tool",
    toolName: "lookup_order",
    input: { orderId: "demo-123" },
  });

  const completed = await until(
    () => items(otherTenant),
    (list) => list.some((item) => item.type === "turn.completed"),
    "the other Tenant's turn"
  );
  expect(JSON.stringify(completed.find((item) => item.type === "turn.completed"))).toContain(
    "from the normal model"
  );
  expect(normalCalls).toBe(1);
});

it("counts the fixture model as a configured model in Tenant status", async () => {
  const fixtureTenant = await startTestTenant({ useHostModel: true });
  open.push(fixtureTenant);
  const otherTenant = await startTestTenant({ useHostModel: true });
  open.push(otherTenant);
  expect(await modelCheck(fixtureTenant)).toBe(false);
  await seed(fixtureTenant, { fixtureModel: true });
  expect(await modelCheck(fixtureTenant)).toBe(true);
  expect(await modelCheck(otherTenant)).toBe(false);
});

it("rejects a fixtureModel value other than true", async () => {
  const runtime = await startTestTenant();
  open.push(runtime);
  const response = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: runtime.headers(),
    body: JSON.stringify({ requestId: randomUUID(), fixtureModel: false }),
  });
  expect(response.status).toBe(400);
});
