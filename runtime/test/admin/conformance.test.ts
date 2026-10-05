import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAdmin, deriveStudioToken } from "@nylorun/admin";
import {
  ERROR_CODES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import { RejectedResponseSchema } from "@nylorun/core/contracts";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { isolatedTestDatabase } from "../support/store.js";

const closers: { close(): Promise<void> }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function keyHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
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

async function startHost() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-admin-conf-"));
  roots.push(hostRoot);
  // A database of its own: the Host creates its Tenant there.
  const database = await isolatedTestDatabase();
  const runtime = await startEphemeralRuntime({
    hostRoot,
    retainRoot: true,
    database: database.sql,
  });
  closers.push(runtime, { close: database.drop });
  return { ...runtime, database: database.sql };
}

it("A5: the Admin API is gone: /v1/admin/* answers as any unknown route does, with any key", async () => {
  const runtime = await startHost();
  const { url, adminKey, managementKey, applicationKey } = runtime;
  for (const key of [adminKey, managementKey, applicationKey]) {
    const unknown = await getJson(`${url}/v1/no-such-route`, { headers: keyHeaders(key) });
    expect(unknown.status).toBe(404);
    expect(ERROR_CODES).toContain(RejectedResponseSchema.parse(unknown.body).code);
    for (const [method, path] of [
      ["GET", "/v1/admin/status"],
      ["GET", "/v1/admin/host"],
      ["POST", "/v1/admin/host/shutdown"],
      ["GET", "/v1/admin/keys"],
      ["PUT", "/v1/admin/keys/backend"],
      ["DELETE", "/v1/admin/keys/backend"],
      ["GET", "/v1/admin/openapi.json"],
      ["GET", "/v1/admin/tenants"],
    ] as const) {
      const gone = await getJson(`${url}${path}`, { method, headers: keyHeaders(key) });
      expect({ status: gone.status, body: gone.body }, `${method} ${path}`).toEqual({
        status: unknown.status,
        body: unknown.body,
      });
    }
  }
  // The old shutdown route stopped nothing; SIGTERM is the only way (host/main.ts).
  expect((await getJson(`${url}/ready`)).status).toBe(200);
  const health = (await getJson(`${url}/health`)).body as { protocol: { features: string[] } };
  expect(health.protocol.features).toContain("management-api");
  expect(health.protocol.features).not.toContain("operator-keys");
});

it("the Studio key the admin key derives reaches the Tenant; nothing else derived does", async () => {
  const runtime = await startHost();
  const { url, adminKey, tenantId, applicationKey, managementKey } = runtime;
  const admin = createAdmin({ url, key: managementKey });
  const agents = (key: string, tenant?: string) =>
    getJson(`${url}/v1/agents`, { headers: tenantApiHeaders(key, tenant) });

  expect((await agents(deriveStudioToken(adminKey))).status).toBe(200);
  expect((await agents(applicationKey)).status).toBe(200);
  // Protocol 4 clients name the Tenant; this Host's id is served, another is the opaque 404.
  expect((await agents(applicationKey, tenantId)).status).toBe(200);
  expect((await agents(applicationKey, newTenantId())).status).toBe(404);
  // Other admin keys and the admin key itself reach nothing; the admin client derives no
  // Tenant key (protocol 7).
  expect("deriveTenantKey" in admin).toBe(false);
  expect((await agents(deriveStudioToken("f".repeat(64)))).status).toBe(404);
  expect((await agents(adminKey)).status).toBe(404);
});
