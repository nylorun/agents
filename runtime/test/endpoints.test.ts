/**
 * Action endpoint registration (design: Action endpoints §4.2): `PUT`, `GET` and
 * `DELETE /v1/endpoints`, and the application-key rule. Endpoints are the only way an agent
 * is served: the executor routes are gone.
 */
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import { ListEndpointsResponseSchema } from "@nylorun/core/contracts";
import type { TenantContext } from "../src/tenant/context.js";
import { startEndpoint } from "./support/endpoint.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
const live: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of live.splice(0)) await runtime.close().catch(() => {});
});

async function host() {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: async (effect) => {
      const call = effect.input as { prompt?: { kind?: string }[] };
      if (call.prompt?.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "ok" }] };
      return { output: [{ type: "tool-call", id: "call-1", name: "save", args: {} }] };
    },
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
  // A delivery token, the one other credential an endpoint holds, cannot manage endpoints.
  const agent = Agent({ id: "support" })
    .use({ id: "notes", tools: [tool({ name: "save", input: z.object({}), async run() { return "saved"; } })] })
    .build();
  await call(runtime.url, "PUT", "/v1/agents/support", {
    requestId: "put",
    manifest: agent.manifest,
    implementationVersion: "dev",
  });
  const endpoint = await startEndpoint({ runtime });
  live.push(endpoint);
  await call(runtime.url, "PUT", "/v1/endpoints", { endpoints: [registration("support", { url: endpoint.url })] });
  await call(runtime.url, "PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "support", ownerUserId: "user" });
  await call(runtime.url, "POST", "/v1/sessions/s1/commands", {
    type: "message",
    requestId: "m1",
    idempotencyKey: "m1",
    content: "save",
  });
  const { token } = await endpoint.next();
  const body = { endpoints: [registration("triage")] };
  for (const [method, path] of [["PUT", "/v1/endpoints"], ["GET", "/v1/endpoints"], ["DELETE", "/v1/endpoints/triage"]]) {
    const refused = await call(runtime.url, method!, path!, method === "PUT" ? body : undefined, token);
    expect(refused.status, `${method} ${path}`).toBe(403);
  }
  const anonymous = await fetch(`${runtime.url}/v1/endpoints`);
  expect(anonymous.status).toBe(404);
});

it("has no executor routes any more", async () => {
  const runtime = await host();
  for (const [method, path] of [
    ["GET", "/v1/executors"],
    ["PUT", "/v1/executors"],
    ["GET", "/v1/executors/connect"],
    ["GET", "/v1/actions"],
    ["POST", "/v1/actions/a1/claim"],
  ]) {
    const response = await call(runtime.url, method!, path!, method === "GET" ? undefined : {});
    expect(response.status, `${method} ${path}`).toBe(404);
  }
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
