import { expect, it } from "vitest";
import {
  AdminStatusSchema,
  CreateTenantRequestSchema,
} from "@nylorun/core/contracts";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import {
  ADMIN_KEY,
  adminHeaders,
  createFakeModule,
  getJson,
  newTenantId,
  startTestHost,
  tenantHeaders,
} from "./support.js";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";

it("C4: admin routes reject non-admin bearer with opaque 404", async () => {
  const { url } = await startTestHost();
  const { status, body } = await getJson(`${url}/v1/admin/host`, {
    headers: {
      ...adminHeaders("not-the-admin-key-000000000000000000000000000000000000"),
    },
  });
  expect(status).toBe(404);
  expect(body).toEqual(OPAQUE_NOT_FOUND);
});

it("C4: admin routes never forward to Tenant handlers", async () => {
  let tenantHandled = false;
  const tenantId = newTenantId();
  const module = createFakeModule({
    tenants: [
      {
        id: tenantId,
        name: "a",
        state: "open",
        handle: {
          envelope: {
            id: tenantId,
            name: "a",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            schemaVersion: 1,
          },
          async handle(_q, response) {
            tenantHandled = true;
            response.writeHead(200);
            response.end("{}");
          },
          summary: () => ({
            ready: true,
            runningSessions: 0,
            connectedExecutors: 0,
            pendingActions: 0,
            uncertainEffects: 0,
          }),
          async drain() {},
          async close() {},
        },
      },
    ],
  });
  const { url } = await startTestHost({ module });
  await getJson(`${url}/v1/admin/tenants`, {
    headers: {
      ...adminHeaders(),
      // Tenant header present must not route to Tenant
      ...tenantHeaders(tenantId),
      authorization: `Bearer ${ADMIN_KEY}`,
    },
  });
  expect(tenantHandled).toBe(false);
});

it("C4/C5: admin create, list, status, delete and host status", async () => {
  const module = createFakeModule();
  const { url, config } = await startTestHost({ module });
  const tenantId = newTenantId();
  const createBody = CreateTenantRequestSchema.parse({
    tenantId,
    name: "demo",
    principalId: "principal_1",
    credentialHash: "a".repeat(64),
    idempotencyKey: "idem-1",
  });
  const created = await getJson(`${url}/v1/admin/tenants`, {
    method: "POST",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify(createBody),
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ id: tenantId, name: "demo" });

  const listed = await getJson(`${url}/v1/admin/tenants`, {
    headers: adminHeaders(),
  });
  expect(listed.status).toBe(200);
  expect(listed.body).toEqual([
    expect.objectContaining({ id: tenantId, state: "open" }),
  ]);

  const status = await getJson(`${url}/v1/admin/tenants/${tenantId}`, {
    headers: adminHeaders(),
  });
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ id: tenantId, state: "open" });

  const host = await getJson(`${url}/v1/admin/host`, {
    headers: adminHeaders(),
  });
  expect(host.status).toBe(200);
  const parsed = AdminStatusSchema.parse(host.body);
  expect(parsed.service).toBe("nylorun-runtime");
  expect(parsed.host?.hostId).toBe(config.hostId);
  expect(parsed.version).toBeTruthy();
  expect(parsed.protocol.min).toBe(PROTOCOL_VERSION);
  expect(parsed.tenants).toHaveLength(1);
  expect(parsed.aggregate).toEqual({
    runningSessions: 0,
    connectedExecutors: 0,
    pendingActions: 0,
    uncertainEffects: 0,
  });

  const deleted = await getJson(
    `${url}/v1/admin/tenants/${tenantId}?activeWork=cancel`,
    { method: "DELETE", headers: adminHeaders() },
  );
  expect(deleted.status).toBe(204);
  expect(module.deleteCalls).toEqual([
    { id: tenantId, activeWork: "cancel" },
  ]);
});

it("C4: admin create rejects the reserved principal id studio", async () => {
  const module = createFakeModule();
  const { url } = await startTestHost({ module });
  const created = await getJson(`${url}/v1/admin/tenants`, {
    method: "POST",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: newTenantId(),
      name: "demo",
      principalId: "studio",
      credentialHash: "a".repeat(64),
      idempotencyKey: "idem-1",
      studioCredentialHash: "b".repeat(64),
    }),
  });
  expect(created.status).toBe(400);
  expect(module.createCalls).toHaveLength(0);
});

it("C5: GET /v1/admin/host uses only list() and summarize()", async () => {
  const module = createFakeModule({
    tenants: [
      {
        id: newTenantId(),
        name: "a",
        state: "open",
        summary: {
          ready: true,
          runningSessions: 2,
          connectedExecutors: 1,
          pendingActions: 3,
          uncertainEffects: 0,
        },
      },
    ],
  });
  const { url } = await startTestHost({ module });
  const host = await getJson(`${url}/v1/admin/host`, {
    headers: adminHeaders(),
  });
  const parsed = AdminStatusSchema.parse(host.body);
  expect(parsed.aggregate.runningSessions).toBe(2);
  expect(parsed.aggregate.connectedExecutors).toBe(1);
  expect(parsed.aggregate.pendingActions).toBe(3);
});
