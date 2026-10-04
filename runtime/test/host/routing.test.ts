import { expect, it, vi } from "vitest";
import { TENANT_HEADER } from "@nylorun/core/compatibility";
import {
  FAKE_TENANT_ID,
  createFakeModule,
  getJson,
  newTenantId,
  protocolHeaders,
  startTestHost,
  tenantHeaders,
} from "./support.js";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";

it("protocol 5: a request naming no Tenant reaches the Host's Tenant", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  const { status, body } = await getJson(`${url}/v1/sessions`, {
    headers: tenantHeaders(),
  });
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, tenantId: FAKE_TENANT_ID });
});

it("protocol 4 window: Nylorun-Tenant naming the Host's Tenant is served", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  const { status, body } = await getJson(`${url}/v1/sessions`, {
    headers: tenantHeaders(undefined, FAKE_TENANT_ID),
  });
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, tenantId: FAKE_TENANT_ID });
});

it("a Nylorun-Tenant naming another Tenant, or a malformed one, is the opaque 404", async () => {
  const module = createFakeModule();
  const fetchSpy = vi.fn(async () => new Response("{}"));
  module.fake.handle = {
    envelope: module.tenant().envelope!,
    fetch: fetchSpy,
    summary: async () => ({
      ready: true,
      runningSessions: 0,
      inFlightDeliveries: 0,
      pendingActions: 0,
      uncertainEffects: 0,
    }),
    drain: async () => {},
    close: async () => {},
  };
  const { url } = await startTestHost({ module });
  for (const named of [newTenantId(), "not-a-tenant-id"]) {
    const { status, body } = await getJson(`${url}/v1/agents`, {
      headers: tenantHeaders(undefined, named),
    });
    expect(status).toBe(404);
    expect(body).toEqual(OPAQUE_NOT_FOUND);
  }
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("ignores a Nylorun-Key header, which no longer names a Tenant (protocol 7)", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  for (const key of [`nr_pub_${newTenantId()}_${"0".repeat(32)}`, "nr_pub_nope"]) {
    const { status } = await getJson(`${url}/v1/agents`, {
      headers: protocolHeaders({ "Nylorun-Key": key }),
    });
    expect(status).toBe(200);
  }
});

it("C3: tenant id in query or body is ignored for selection", async () => {
  const other = newTenantId();
  const { url } = await startTestHost({ module: createFakeModule() });
  const { status, body } = await getJson(
    `${url}/v1/agents?${TENANT_HEADER}=${other}&tenant=${other}`,
    {
      method: "POST",
      headers: {
        ...tenantHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenant: other, [TENANT_HEADER]: other }),
    },
  );
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, tenantId: FAKE_TENANT_ID });
});

it("a Tenant that could not be opened answers the opaque 404, whatever the request names", async () => {
  const module = createFakeModule({
    tenant: {
      state: "unavailable",
      cause: {
        code: "kek-missing",
        message: "vault key missing",
        repair: "restore vault-kek",
      },
    },
  });
  const { url } = await startTestHost({ module });
  for (const headers of [tenantHeaders(), tenantHeaders(undefined, FAKE_TENANT_ID)]) {
    const response = await getJson(`${url}/v1/agents`, { headers });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(OPAQUE_NOT_FOUND);
  }
});
