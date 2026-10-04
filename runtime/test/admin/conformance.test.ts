import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/agents";
import {
  createAdmin,
  deriveStudioToken,
  deriveTenantKey,
} from "@nylorun/admin";
import {
  ERROR_CODES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import { AdminStatusSchema, RejectedResponseSchema } from "@nylorun/core/contracts";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { startEndpoint } from "../support/endpoint.js";
import { isolatedTestDatabase } from "../support/store.js";

const closers: { close(): Promise<void> }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function adminHeaders(adminKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

/** Protocol 5: no Tenant named; `tenant` adds `Nylorun-Tenant`, as a protocol 4 client sends it. */
function tenantApiHeaders(applicationKey: string, tenant?: string): Record<string, string> {
  return {
    authorization: `Bearer ${applicationKey}`,
    ...(tenant === undefined ? {} : { [TENANT_HEADER]: tenant }),
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  };
}

async function getJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep */
  }
  return { status: response.status, body, headers: response.headers };
}

async function startHost(
  options: { model?: { kind: "fixture" }; derivedPrincipals?: readonly string[] } = {},
) {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-admin-conf-"));
  roots.push(hostRoot);
  // A database of its own: the Host creates its Tenant there.
  const database = await isolatedTestDatabase();
  const runtime = await startEphemeralRuntime({
    hostRoot,
    baseline: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    retainRoot: true,
    ...(options.model ? { model: options.model } : {}),
    ...(options.derivedPrincipals ? { derivedPrincipals: options.derivedPrincipals } : {}),
    database: database.sql,
  });
  closers.push(runtime, { close: database.drop });
  return { ...runtime, database: database.sql };
}

it("A7: Admin API conformance — status names the Host's Tenant and its work; no Tenant routes", async () => {
  // The fixture model calls `lookup_order`, so the Tenant has a delivery in flight.
  const runtime = await startHost({ model: { kind: "fixture" } });
  const { url, adminKey, tenantId, applicationKey } = runtime;
  const headers = adminHeaders(adminKey);

  const status = await getJson(`${url}/v1/admin/status`, { headers });
  const host = await getJson(`${url}/v1/admin/host`, { headers });
  expect(status.status).toBe(200);
  expect(host.status).toBe(200);
  expect(host.body).toEqual(status.body);
  const parsedStatus = AdminStatusSchema.parse(status.body);
  expect(parsedStatus.service).toBe("nylorun-runtime");
  expect(parsedStatus.host).toEqual({
    hostId: expect.any(String),
    url,
    pid: expect.any(Number),
  });
  expect(parsedStatus.host!.hostId).toMatch(/^host_/);
  expect(parsedStatus.tenant).toEqual({
    id: tenantId,
    name: "ephemeral",
    state: "open",
    envelope: expect.objectContaining({ id: tenantId, name: "ephemeral" }),
  });
  // The client parses the same answer.
  expect((await createAdmin({ url, key: adminKey }).status()).tenant.id).toBe(tenantId);

  // The Tenant routes of protocol 4 are gone, with the admin key too.
  for (const [method, path] of [
    ["GET", "/v1/admin/tenants"],
    ["POST", "/v1/admin/tenants"],
    ["GET", `/v1/admin/tenants/${tenantId}`],
    ["DELETE", `/v1/admin/tenants/${tenantId}?activeWork=cancel`],
  ] as const) {
    const gone = await getJson(`${url}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ name: "second" }) } : {}),
    });
    expect(gone.status, `${method} ${path}`).toBe(404);
    const rejected = RejectedResponseSchema.parse(gone.body);
    expect(ERROR_CODES).toContain(rejected.code);
  }

  const agent = Agent({ id: "conf-agent", name: "Conf" })
    .use({
      id: "orders",
      tools: [
        tool({
          name: "lookup_order",
          input: z.object({ orderId: z.string() }),
          async run() {
            return "found";
          },
        }),
      ],
    })
    .build();
  const api = tenantApiHeaders(applicationKey);
  const saved = await getJson(`${url}/v1/agents/${agent.manifest.id}`, {
    method: "PUT",
    headers: api,
    body: JSON.stringify({
      requestId: randomBytes(8).toString("hex"),
      implementationVersion: "dev",
      manifest: agent.manifest,
    }),
  });
  expect(saved.status).toBe(200);

  // An endpoint that never answers keeps the delivery in flight.
  const endpoint = await startEndpoint({ runtime: { url }, answer: () => "hang" });
  closers.push(endpoint);
  const registered = await getJson(`${url}/v1/endpoints`, {
    method: "PUT",
    headers: api,
    body: JSON.stringify({
      endpoints: [{ agentId: agent.manifest.id, url: endpoint.url, implementationVersion: "dev" }],
    }),
  });
  expect(registered.status).toBe(200);
  expect(
    (
      await getJson(`${url}/v1/sessions/busy-session`, {
        method: "PUT",
        headers: api,
        body: JSON.stringify({ requestId: "busy-session", agentId: agent.manifest.id, ownerUserId: "user" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await getJson(`${url}/v1/sessions/busy-session/commands`, {
        method: "POST",
        headers: api,
        body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "look it up" }),
      })
    ).status,
  ).toBe(200);
  await endpoint.next();

  // The Host sees the delivery in flight.
  let inFlight = 0;
  for (let i = 0; i < 50 && inFlight === 0; i++) {
    const snap = await getJson(`${url}/v1/admin/status`, { headers });
    inFlight = AdminStatusSchema.parse(snap.body).aggregate.inFlightDeliveries;
    if (inFlight === 0) await new Promise((r) => setTimeout(r, 20));
  }
  expect(inFlight).toBe(1);
});

it("the Studio key and the project key the admin key derives reach the Tenant; nothing else derived does", async () => {
  const runtime = await startHost({ derivedPrincipals: ["project"] });
  const { url, adminKey, tenantId, applicationKey } = runtime;
  const admin = createAdmin({ url, key: adminKey });
  const agents = (key: string, tenant?: string) =>
    getJson(`${url}/v1/agents`, { headers: tenantApiHeaders(key, tenant) });

  expect((await agents(deriveStudioToken(adminKey, tenantId))).status).toBe(200);
  expect((await agents(deriveTenantKey(adminKey, tenantId, "project"))).status).toBe(200);
  expect((await agents(admin.deriveTenantKey(tenantId, "project"))).status).toBe(200);
  expect((await agents(applicationKey)).status).toBe(200);
  // Protocol 4 clients name the Tenant; this Host's id is served, another is the opaque 404.
  expect((await agents(applicationKey, tenantId)).status).toBe(200);
  expect((await agents(applicationKey, newTenantId())).status).toBe(404);
  // Principals the Host was not configured with, other admin keys and the admin key itself
  // reach nothing.
  expect((await agents(deriveTenantKey(adminKey, tenantId, "other"))).status).toBe(404);
  expect((await agents(deriveTenantKey("f".repeat(64), tenantId, "project"))).status).toBe(404);
  expect((await agents(deriveStudioToken("f".repeat(64), tenantId))).status).toBe(404);
  expect((await agents(adminKey)).status).toBe(404);
});
