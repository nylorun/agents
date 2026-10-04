import { expect, it } from "vitest";
import { AdminStatusSchema } from "@nylorun/core/contracts";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import {
  ADMIN_KEY,
  FAKE_TENANT_ID,
  adminHeaders,
  createFakeModule,
  getJson,
  startTestHost,
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
  const module = createFakeModule();
  module.fake.handle = {
    envelope: module.tenant().envelope!,
    async fetch() {
      tenantHandled = true;
      return new Response("{}");
    },
    summary: async () => ({
      ready: true,
      runningSessions: 0,
      inFlightDeliveries: 0,
      pendingActions: 0,
      uncertainEffects: 0,
    }),
    async drain() {},
    async close() {},
  };
  const { url } = await startTestHost({ module });
  for (const path of ["/v1/admin/status", "/v1/admin/tenants"])
    await getJson(`${url}${path}`, {
      headers: { ...adminHeaders(), authorization: `Bearer ${ADMIN_KEY}` },
    });
  expect(tenantHandled).toBe(false);
});

it("P14: the Admin Tenant routes are gone: 404 with the admin key", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  for (const [method, path] of [
    ["GET", "/v1/admin/tenants"],
    ["POST", "/v1/admin/tenants"],
    ["GET", `/v1/admin/tenants/${FAKE_TENANT_ID}`],
    ["DELETE", `/v1/admin/tenants/${FAKE_TENANT_ID}`],
  ] as const) {
    const response = await getJson(`${url}${path}`, {
      method,
      headers: { ...adminHeaders(), "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(response.body).toMatchObject({ status: "rejected", code: "not_found" });
  }
});

it("C5: GET /v1/admin/host reports the Host, its Tenant and the aggregate", async () => {
  const module = createFakeModule({
    tenant: {
      name: "demo",
      summary: {
        ready: true,
        runningSessions: 2,
        inFlightDeliveries: 1,
        pendingActions: 3,
        uncertainEffects: 0,
      },
    },
  });
  const { url, config } = await startTestHost({ module });
  const host = await getJson(`${url}/v1/admin/host`, {
    headers: adminHeaders(),
  });
  expect(host.status).toBe(200);
  const parsed = AdminStatusSchema.parse(host.body);
  expect(parsed.service).toBe("nylorun-runtime");
  expect(parsed.host?.hostId).toBe(config.hostId);
  expect(parsed.version).toBeTruthy();
  expect(parsed.protocol).toMatchObject({ min: HOST_PROTOCOL.min, max: HOST_PROTOCOL.max });
  expect(parsed.tenant).toMatchObject({ id: FAKE_TENANT_ID, name: "demo", state: "open" });
  expect(parsed.tenant.cause).toBeUndefined();
  expect(parsed).not.toHaveProperty("tenants");
  expect(parsed.aggregate).toEqual({
    runningSessions: 2,
    inFlightDeliveries: 1,
    pendingActions: 3,
    uncertainEffects: 0,
  });
});

it("C5: a Tenant that could not be opened is reported with its cause", async () => {
  const cause = {
    code: "schema-too-new" as const,
    message: "The nylorun schema is at version 99",
    repair: "run that version or newer",
  };
  const module = createFakeModule({ tenant: { state: "unavailable", cause } });
  const { url } = await startTestHost({ module });
  const status = AdminStatusSchema.parse(
    (await getJson(`${url}/v1/admin/status`, { headers: adminHeaders() })).body,
  );
  expect(status.tenant).toMatchObject({ id: FAKE_TENANT_ID, state: "unavailable", cause });
});

it("F9 I1: the key routes answer 503 while the Tenant is not open, and need the admin key", async () => {
  const { url } = await startTestHost({
    module: createFakeModule({ tenant: { state: "unavailable" } }),
  });
  for (const [method, path] of [
    ["GET", "/v1/admin/keys"],
    ["PUT", "/v1/admin/keys/backend"],
    ["DELETE", "/v1/admin/keys/backend"],
  ] as const) {
    const unopened = await getJson(`${url}${path}`, {
      method,
      headers: { ...adminHeaders(), authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(unopened.status, `${method} ${path}`).toBe(503);
    expect(unopened.body).toMatchObject({ code: "request_rejected" });
    const wrong = await getJson(`${url}${path}`, {
      method,
      headers: adminHeaders("not-the-admin-key-000000000000000000000000000000000000"),
    });
    expect(wrong.status).toBe(404);
    expect(wrong.body).toEqual(OPAQUE_NOT_FOUND);
  }
});
