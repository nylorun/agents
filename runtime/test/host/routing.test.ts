import { expect, it, vi } from "vitest";
import { PROTOCOL_HEADER, TENANT_HEADER } from "@nylorun/core/compatibility";
import { ProtocolRejectedResponseSchema } from "@nylorun/core/contracts";
import {
  createFakeModule,
  getJson,
  newTenantId,
  protocolHeaders,
  startTestHost,
  tenantHeaders,
} from "./support.js";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";

it("C3: missing Nylorun-Tenant returns 400 before resolve", async () => {
  const module = createFakeModule();
  const resolve = vi.spyOn(module, "resolve");
  const { url } = await startTestHost({ module });
  const { status, body } = await getJson(`${url}/v1/agents`, {
    headers: protocolHeaders(),
  });
  expect(status).toBe(400);
  expect(body).toMatchObject({
    status: "rejected",
    code: "invalid_request",
  });
  expect(resolve).not.toHaveBeenCalled();
});

it("C3: malformed Nylorun-Tenant returns 400 before resolve", async () => {
  const module = createFakeModule();
  const resolve = vi.spyOn(module, "resolve");
  const { url } = await startTestHost({ module });
  const { status } = await getJson(`${url}/v1/agents`, {
    headers: protocolHeaders({ [TENANT_HEADER]: "not-a-tenant-id" }),
  });
  expect(status).toBe(400);
  expect(resolve).not.toHaveBeenCalled();
});

it("C3: tenant id in query or body is ignored for selection", async () => {
  const tenantId = newTenantId();
  const other = newTenantId();
  const module = createFakeModule({
    tenants: [{ id: tenantId, name: "a", state: "open" }],
  });
  const { url } = await startTestHost({ module });
  const { status, body } = await getJson(
    `${url}/v1/agents?${TENANT_HEADER}=${other}&tenant=${other}`,
    {
      method: "POST",
      headers: {
        ...tenantHeaders(tenantId),
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenant: other, [TENANT_HEADER]: other }),
    },
  );
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, tenantId });
});

it("C3: unknown and quarantined tenants return opaque 404", async () => {
  const openId = newTenantId();
  const quarantinedId = newTenantId();
  const module = createFakeModule({
    tenants: [
      { id: openId, name: "a", state: "open" },
      {
        id: quarantinedId,
        name: "b",
        state: "quarantined",
        quarantine: {
          code: "kek-missing",
          message: "vault key missing",
          repair: "nylorun tenant status",
        },
      },
    ],
  });
  const { url } = await startTestHost({ module });
  const unknown = await getJson(`${url}/v1/agents`, {
    headers: tenantHeaders(newTenantId()),
  });
  const quarantined = await getJson(`${url}/v1/agents`, {
    headers: tenantHeaders(quarantinedId),
  });
  expect(unknown.status).toBe(404);
  expect(quarantined.status).toBe(404);
  expect(unknown.body).toEqual(OPAQUE_NOT_FOUND);
  expect(quarantined.body).toEqual(OPAQUE_NOT_FOUND);
});

it("C3: open tenant is forwarded to TenantHandle", async () => {
  const tenantId = newTenantId();
  const module = createFakeModule({
    tenants: [{ id: tenantId, name: "a", state: "open" }],
  });
  const { url } = await startTestHost({ module });
  const { status, body } = await getJson(`${url}/v1/sessions`, {
    headers: tenantHeaders(tenantId),
  });
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, tenantId });
});
