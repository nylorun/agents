import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/agents";
import { createAdmin, deriveStudioToken } from "@nylorun/admin";
import {
  ERROR_CODES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newPrincipalId,
  newTenantId,
} from "@nylorun/core/compatibility";
import {
  AdminStatusSchema,
  AdminTenantSchema,
  AdminTenantStatusSchema,
  RejectedResponseSchema,
  TenantEnvelopeSchema,
} from "@nylorun/core/contracts";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { TEST_STORE, isolatedTestDatabase } from "../support/store.js";

const closers: { close(): Promise<void> }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function hashCredential(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function adminHeaders(adminKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

function tenantApiHeaders(
  tenantId: string,
  applicationKey: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${applicationKey}`,
    [TENANT_HEADER]: tenantId,
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
  // On Postgres the Host sees every Tenant in its database: give it its own.
  const database =
    TEST_STORE === "postgres" ? await isolatedTestDatabase() : undefined;
  const runtime = await startEphemeralRuntime({
    hostRoot,
    baseline: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    retainRoot: true,
    ...(database ? { database: database.sql } : {}),
  });
  closers.push(runtime);
  if (database) closers.push({ close: database.drop });
  return { ...runtime, database: database?.sql };
}

function createBody(overrides?: {
  tenantId?: string;
  name?: string;
  principalId?: string;
  credentialHash?: string;
  idempotencyKey?: string;
}) {
  const applicationKey = randomBytes(32).toString("hex");
  return {
    applicationKey,
    request: {
      tenantId: overrides?.tenantId ?? newTenantId(),
      name: overrides?.name ?? "conformance",
      principalId: overrides?.principalId ?? newPrincipalId(),
      credentialHash:
        overrides?.credentialHash ?? hashCredential(applicationKey),
      idempotencyKey:
        overrides?.idempotencyKey ?? randomBytes(16).toString("hex"),
    },
  };
}

it("A7: Admin API conformance — create, lost response, conflict, list, get, quarantine, delete modes, status", async () => {
  const runtime = await startHost();
  const { url, adminKey, database } = runtime;
  const headers = adminHeaders(adminKey);

  const first = createBody({ name: "primary" });
  const created = await getJson(`${url}/v1/admin/tenants`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(first.request),
  });
  expect(created.status).toBe(201);
  const envelope = TenantEnvelopeSchema.parse(created.body);
  expect(envelope.id).toBe(first.request.tenantId);
  expect(envelope.name).toBe("primary");

  const retry = await getJson(`${url}/v1/admin/tenants`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(first.request),
  });
  expect(retry.status).toBe(200);
  expect(TenantEnvelopeSchema.parse(retry.body)).toMatchObject({
    id: envelope.id,
    createdAt: envelope.createdAt,
  });

  const conflict = await getJson(`${url}/v1/admin/tenants`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      ...first.request,
      credentialHash: "ef".repeat(32),
      idempotencyKey: randomBytes(16).toString("hex"),
    }),
  });
  expect(conflict.status).toBe(409);
  const conflictBody = RejectedResponseSchema.parse(conflict.body);
  expect(conflictBody.code).toBe("tenant_conflict");
  expect(ERROR_CODES).toContain(conflictBody.code);

  const listed = await getJson(`${url}/v1/admin/tenants`, { headers });
  expect(listed.status).toBe(200);
  expect(Array.isArray(listed.body)).toBe(true);
  const rows = (listed.body as unknown[]).map((row) =>
    AdminTenantSchema.parse(row),
  );
  expect(
    rows.some((r) => r.id === first.request.tenantId && r.state === "open"),
  ).toBe(true);
  expect(rows.length).toBeGreaterThanOrEqual(2);

  const got = await getJson(
    `${url}/v1/admin/tenants/${first.request.tenantId}`,
    { headers },
  );
  expect(got.status).toBe(200);
  AdminTenantStatusSchema.parse(got.body);
  expect(got.body).toMatchObject({
    id: first.request.tenantId,
    state: "open",
  });

  // A schema without its envelope row. The in-memory store cannot hold a broken Tenant;
  // the module's quarantine is covered by the Tenant module conformance suite.
  if (TEST_STORE === "postgres") {
    const badId = newTenantId();
    const sql = database!;
    await sql`CREATE SCHEMA ${sql(tenantSchemaName(badId))}`;
    const quarantined = await getJson(`${url}/v1/admin/tenants/${badId}`, {
      headers,
    });
    expect(quarantined.status).toBe(200);
    const qStatus = AdminTenantStatusSchema.parse(quarantined.body);
    expect(qStatus.state).toBe("quarantined");
    expect(qStatus.quarantine?.code).toBe("envelope-invalid");
    expect(qStatus.quarantine?.repair).toMatch(/nylo tenant status/);
  }

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

  for (const mode of ["refuse", "drain", "cancel"] as const) {
    const idle = createBody({ name: `idle-${mode}` });
    const made = await getJson(`${url}/v1/admin/tenants`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(idle.request),
    });
    expect(made.status).toBe(201);
    const deleted = await getJson(
      `${url}/v1/admin/tenants/${idle.request.tenantId}?activeWork=${mode}`,
      { method: "DELETE", headers },
    );
    expect(deleted.status, mode).toBe(204);
  }

  const busy = createBody({ name: "busy" });
  const busyCreated = await getJson(`${url}/v1/admin/tenants`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(busy.request),
  });
  expect(busyCreated.status).toBe(201);

  const agent = Agent({ id: "conf-agent", name: "Conf" }).build();
  const saved = await getJson(`${url}/v1/agents/${agent.manifest.id}`, {
    method: "PUT",
    headers: tenantApiHeaders(busy.request.tenantId, busy.applicationKey),
    body: JSON.stringify({
      requestId: randomBytes(8).toString("hex"),
      implementationVersion: "dev",
      manifest: agent.manifest,
    }),
  });
  expect(saved.status).toBe(200);

  const executorToken = randomBytes(32).toString("hex");
  const registered = await getJson(`${url}/v1/executors`, {
    method: "PUT",
    headers: tenantApiHeaders(busy.request.tenantId, busy.applicationKey),
    body: JSON.stringify({
      executors: [
        {
          token: executorToken,
          agentId: agent.manifest.id,
          implementationVersion: "dev",
        },
      ],
    }),
  });
  expect(registered.status).toBe(200);

  const stream = await fetch(`${url}/v1/executors/connect`, {
    headers: {
      authorization: `Bearer ${executorToken}`,
      [TENANT_HEADER]: busy.request.tenantId,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
  });
  expect(stream.status).toBe(200);

  // Wait until the Host sees the connected executor.
  for (let i = 0; i < 50; i++) {
    const snap = await getJson(`${url}/v1/admin/status`, { headers });
    const agg = AdminStatusSchema.parse(snap.body).aggregate;
    if (agg.connectedExecutors > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  const refused = await getJson(
    `${url}/v1/admin/tenants/${busy.request.tenantId}?activeWork=refuse`,
    { method: "DELETE", headers },
  );
  expect(refused.status).toBe(409);
  const refusedBody = RejectedResponseSchema.parse(refused.body);
  expect(refusedBody.code).toBe("active_work");

  await stream.body?.cancel();

  const cancelled = await getJson(
    `${url}/v1/admin/tenants/${busy.request.tenantId}?activeWork=cancel`,
    { method: "DELETE", headers },
  );
  expect(cancelled.status).toBe(204);
});

it("registers principal studio from studioCredentialHash; the derived Studio key reaches Tenant routes", async () => {
  const runtime = await startHost();
  const { url, adminKey } = runtime;
  const admin = createAdmin({ url, key: adminKey });

  const { tenant, applicationKey } = await admin.createTenant({ name: "studio" });
  const studioKey = deriveStudioToken(adminKey, tenant.id);
  const agents = (key: string) =>
    getJson(`${url}/v1/agents`, { headers: tenantApiHeaders(tenant.id, key) });
  expect((await agents(studioKey)).status).toBe(200);
  expect((await agents(applicationKey)).status).toBe(200);
  // The admin key itself is never a Tenant bearer.
  expect((await agents(adminKey)).status).toBe(404);

  // Idempotent create compares the Studio hash too.
  const headers = {
    ...adminHeaders(adminKey),
    "content-type": "application/json",
  };
  const body = createBody({ name: "studio-retry" });
  const request = {
    ...body.request,
    studioCredentialHash: hashCredential(
      deriveStudioToken(adminKey, body.request.tenantId),
    ),
  };
  const post = (payload: unknown) =>
    getJson(`${url}/v1/admin/tenants`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  expect((await post(request)).status).toBe(201);
  expect((await post(request)).status).toBe(200);
  expect(
    (await post({ ...request, studioCredentialHash: "ef".repeat(32) })).status,
  ).toBe(409);
  const { studioCredentialHash: _omitted, ...withoutStudio } = request;
  expect((await post(withoutStudio)).status).toBe(409);

  // A Tenant created without the hash has no Studio principal.
  const plain = createBody({ name: "no-studio" });
  expect((await post(plain.request)).status).toBe(201);
  const denied = await getJson(`${url}/v1/agents`, {
    headers: tenantApiHeaders(
      plain.request.tenantId,
      deriveStudioToken(adminKey, plain.request.tenantId),
    ),
  });
  expect(denied.status).toBe(404);
});
