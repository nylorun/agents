import { expect, it, vi } from "vitest";
import {
  PUBLISHABLE_KEY_HEADER,
  TENANT_HEADER,
  newPublishableKey,
} from "@nylorun/core/compatibility";
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

it("a publishable key of another Tenant is the opaque 404; a malformed one is 400", async () => {
  const { url } = await startTestHost({ module: createFakeModule() });
  const other = await getJson(`${url}/v1/agents`, {
    headers: protocolHeaders({ [PUBLISHABLE_KEY_HEADER]: newPublishableKey(newTenantId()) }),
  });
  expect(other.status).toBe(404);
  expect(other.body).toEqual(OPAQUE_NOT_FOUND);
  const malformed = await getJson(`${url}/v1/agents`, {
    headers: protocolHeaders({ [PUBLISHABLE_KEY_HEADER]: "nr_pub_nope" }),
  });
  expect(malformed.status).toBe(400);
  expect(malformed.body).toMatchObject({ status: "rejected", code: "invalid_request" });
  const own = await getJson(`${url}/v1/agents`, {
    headers: protocolHeaders({ [PUBLISHABLE_KEY_HEADER]: newPublishableKey(FAKE_TENANT_ID) }),
  });
  expect(own.status).toBe(200);
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
