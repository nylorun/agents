/**
 * Action endpoint registration (design: Action endpoints §4.2): `PUT`, `GET` and
 * `DELETE /v1/endpoints`, the application-key rule, and one path per agent while executors
 * still exist.
 */
import { afterEach, expect, it } from "vitest";
import { ListEndpointsResponseSchema } from "@nylorun/core/contracts";
import type { TenantContext } from "../src/tenant/context.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
const EXECUTOR = "executor-token-value-bbbbbbbb";
const live: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of live.splice(0)) await runtime.close().catch(() => {});
});

async function host() {
  const runtime = await startTestTenant({
    applicationKey: APP,
    executors: [{ token: EXECUTOR, agentId: "support", implementationVersion: "dev" }],
    modelProvider: async () => ({ output: [{ type: "text", text: "ok" }] }),
  });
  live.push(runtime);
  return runtime;
}

const call = (
  url: string,
  method: string,
  path: string,
  body?: unknown,
  key = APP,
  headers: Record<string, string> = {},
) =>
  fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const registration = (agentId: string, fields: Record<string, unknown> = {}) => ({
  agentId,
  url: "http://localhost:3000/nylorun/actions",
  implementationVersion: "dev",
  ...fields,
});

it("registers, lists and removes endpoints with their defaults and health", async () => {
  const runtime = await host();
  const put = await call(runtime.url, "PUT", "/v1/endpoints", {
    endpoints: [registration("triage", { timeoutMs: 30_000, maxConcurrent: 4, manifestHash: "h" })],
  });
  expect(put.status).toBe(200);
  const body = ListEndpointsResponseSchema.parse(await put.json());
  expect(body.endpoints).toEqual([
    {
      agentId: "triage",
      url: "http://localhost:3000/nylorun/actions",
      implementationVersion: "dev",
      manifestHash: "h",
      timeoutMs: 30_000,
      maxConcurrent: 4,
      health: { consecutiveFailures: 0 },
      updatedAt: expect.any(String),
    },
  ]);
  await call(runtime.url, "PUT", "/v1/endpoints", { endpoints: [registration("billing")] });
  const listed = ListEndpointsResponseSchema.parse(
    await (await call(runtime.url, "GET", "/v1/endpoints")).json(),
  );
  expect(listed.endpoints.map((e) => [e.agentId, e.timeoutMs, e.maxConcurrent])).toEqual([
    ["billing", 60_000, 16],
    ["triage", 30_000, 4],
  ]);
  const removed = await call(runtime.url, "DELETE", "/v1/endpoints/triage");
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ agentId: "triage", deleted: true });
  const missing = await call(runtime.url, "DELETE", "/v1/endpoints/triage");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ message: "Endpoint not found" });
});

it("refuses bad registrations with the reason", async () => {
  const runtime = await host();
  for (const endpoints of [
    [registration("a", { url: "ftp://example.com/actions" })],
    [registration("a", { url: "https://user:pass@example.com/actions" })],
    [registration("a", { timeoutMs: 900_000 })],
    [registration("a"), registration("a")],
    [],
  ]) {
    const response = await call(runtime.url, "PUT", "/v1/endpoints", { endpoints });
    expect(response.status, JSON.stringify(endpoints)).toBe(400);
  }
  const listed = await (await call(runtime.url, "GET", "/v1/endpoints")).json();
  expect(listed).toEqual({ endpoints: [] });
});

// Subjects and subject tokens are refused by the route declaration (`scopes: "never"`): see the
// route matrix and `security/subject-scopes.test.ts`.
it("is for the application key only", async () => {
  const runtime = await host();
  const body = { endpoints: [registration("triage")] };
  for (const [method, path] of [["PUT", "/v1/endpoints"], ["GET", "/v1/endpoints"], ["DELETE", "/v1/endpoints/triage"]]) {
    const executor = await call(runtime.url, method!, path!, method === "PUT" ? body : undefined, EXECUTOR);
    expect(executor.status, `${method} ${path}`).toBe(403);
    expect(await executor.json()).toMatchObject({ message: "Application credential required" });
  }
  const anonymous = await fetch(`${runtime.url}/v1/endpoints`);
  expect(anonymous.status).toBe(404);
});

it("serves an agent by an endpoint or an executor, never both", async () => {
  const runtime = await host();
  // Registering an endpoint removes the agent's executor, whose key stops working.
  expect((await call(runtime.url, "GET", "/v1/actions", undefined, EXECUTOR)).status).toBe(200);
  await call(runtime.url, "PUT", "/v1/endpoints", { endpoints: [registration("support")] });
  expect((await call(runtime.url, "GET", "/v1/executors")).status).toBe(200);
  expect(await (await call(runtime.url, "GET", "/v1/executors")).json()).toEqual({ executors: [] });
  expect((await call(runtime.url, "GET", "/v1/actions", undefined, EXECUTOR)).status).toBe(404);
  // And an executor for an agent with an endpoint is refused until the endpoint is removed.
  const executor = { executors: [{ token: EXECUTOR, agentId: "support", implementationVersion: "dev" }] };
  const refused = await call(runtime.url, "PUT", "/v1/executors", executor);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    message: "Agent 'support' is served by an Action endpoint; remove it first (DELETE /v1/endpoints/support)",
  });
  await call(runtime.url, "DELETE", "/v1/endpoints/support");
  expect((await call(runtime.url, "PUT", "/v1/executors", executor)).status).toBe(200);
});

it("keeps health for the same URL and starts over for a new one", async () => {
  const runtime = await host();
  await call(runtime.url, "PUT", "/v1/endpoints", { endpoints: [registration("triage")] });
  const { ctx } = runtime.handle as unknown as { ctx: TenantContext };
  await ctx.store.tx((t) =>
    t.recordEndpointHealth("triage", {
      kind: "failure",
      at: "2030-01-01T00:00:00.000Z",
      code: "endpoint.unreachable",
      message: "connect ECONNREFUSED",
    }),
  );
  const again = await call(runtime.url, "PUT", "/v1/endpoints", {
    endpoints: [registration("triage", { implementationVersion: "v2" })],
  });
  expect((await again.json()).endpoints[0].health).toEqual({
    lastDeliveryAt: "2030-01-01T00:00:00.000Z",
    lastError: { code: "endpoint.unreachable", message: "connect ECONNREFUSED" },
    consecutiveFailures: 1,
  });
  const moved = await call(runtime.url, "PUT", "/v1/endpoints", {
    endpoints: [registration("triage", { url: "https://tunnel.example/actions" })],
  });
  expect((await moved.json()).endpoints[0].health).toEqual({ consecutiveFailures: 0 });
});
