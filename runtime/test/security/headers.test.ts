/**
 * G5 — Header rules: nothing in a request selects the Tenant (protocol 5). A request without
 * `Nylorun-Tenant` reaches the Host's Tenant; one naming another Tenant, or a malformed one,
 * is the opaque 404 before the Tenant sees it; query and body name nothing.
 */
import { expect, it } from "vitest";
import { TENANT_HEADER, newTenantId } from "@nylorun/core/compatibility";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";
import {
  countTenantRows,
  getJson,
  protocolHeaders,
  startSecurityHost,
} from "./support.js";

it("G5: a request without Nylorun-Tenant reaches the Host's Tenant", async () => {
  const host = await startSecurityHost();
  const { status, body } = await getJson(`${host.url}/v1/tenant`, {
    headers: protocolHeaders({ authorization: `Bearer ${host.tenant.managementKey}` }),
  });
  expect(status).toBe(200);
  expect(body).toMatchObject({ tenant: expect.objectContaining({ id: host.tenant.id }) });
});

it("G5: Nylorun-Tenant naming another Tenant, or malformed, is the opaque 404 and changes nothing", async () => {
  const host = await startSecurityHost();
  const before = await countTenantRows(host, "definitions");
  for (const named of [newTenantId(), "not-a-tenant-id"]) {
    const { status, body } = await getJson(`${host.url}/v1/agents/nope`, {
      method: "PUT",
      headers: protocolHeaders({
        [TENANT_HEADER]: named,
        authorization: `Bearer ${host.tenant.applicationKey}`,
      }),
      body: JSON.stringify({
        requestId: `named-${named}`,
        implementationVersion: "dev",
        manifest: { id: "nope", name: "Nope", tools: [] },
      }),
    });
    expect(status, named).toBe(404);
    expect(body, named).toEqual(OPAQUE_NOT_FOUND);
  }
  expect(await countTenantRows(host, "definitions")).toBe(before);
});

it("G5: the Tenant cannot be named by query or body", async () => {
  const host = await startSecurityHost();
  const a = host.tenant;
  const other = newTenantId();
  const { status, body } = await getJson(
    `${host.url}/v1/tenant?${TENANT_HEADER}=${other}&tenant=${other}`,
    {
      method: "GET",
      headers: a.managementHeaders(),
    },
  );
  expect(status).toBe(200);
  expect(body).toMatchObject({
    tenant: expect.objectContaining({ id: a.id }),
  });
  expect(JSON.stringify(body)).not.toContain(other);

  const post = await getJson(`${host.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers: a.managementHeaders(),
    body: JSON.stringify({
      requestId: "seed-header-override",
      tenant: other,
      [TENANT_HEADER]: other,
      sandbox: { backend: "virtual" },
    }),
  });
  expect([200, 400]).toContain(post.status);
  const aStatus = await getJson(`${host.url}/v1/tenant`, {
    headers: a.managementHeaders(),
  });
  expect(aStatus.status).toBe(200);
  expect((aStatus.body as { tenant: { id: string } }).tenant.id).toBe(a.id);
});
