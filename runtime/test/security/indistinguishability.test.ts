/**
 * G6 — Indistinguishability of another Tenant named / a Tenant not opened /
 * credential-rejected.
 */
import { expect, it } from "vitest";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";
import {
  createFakeModule,
  getJson as hostGetJson,
  newTenantId,
  startTestHost,
  tenantHeaders as hostTenantHeaders,
} from "../host/support.js";
import {
  comparableHeaders,
  getRaw,
  startSecurityHost,
  tenantHeaders,
} from "./support.js";

it("G6: another Tenant named and a Tenant that could not open are byte-identical", async () => {
  const unavailable = createFakeModule({
    tenant: {
      state: "unavailable",
      cause: {
        code: "kek-missing",
        message: "vault key missing",
        repair: "restore vault-kek",
      },
    },
  });
  const open = await startTestHost({ module: createFakeModule() });
  const failed = await startTestHost({ module: unavailable });

  const unknown = await getRaw(`${open.url}/v1/agents`, {
    headers: hostTenantHeaders(undefined, newTenantId()),
  });
  const notOpened = await getRaw(`${failed.url}/v1/agents`, {
    headers: hostTenantHeaders(),
  });

  expect(unknown.status).toBe(404);
  expect(notOpened.status).toBe(404);
  expect(JSON.parse(unknown.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(unknown.body).toBe(notOpened.body);
  expect(comparableHeaders(unknown.headers)).toEqual(
    comparableHeaders(notOpened.headers),
  );
});

it("G6: credential-rejected matches another Tenant named in status and body (D5)", async () => {
  const host = await startSecurityHost({ tenantName: "alpha" });
  const other = await startSecurityHost({ tenantName: "beta" });
  const a = host.tenant;
  const b = other.tenant;

  const unknown = await getRaw(`${host.url}/v1/agents`, {
    headers: tenantHeaders(a.applicationKey, newTenantId()),
  });
  const rejected = await getRaw(`${host.url}/v1/agents`, {
    headers: tenantHeaders(b.applicationKey),
  });
  expect(JSON.parse(unknown.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(JSON.parse(rejected.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(unknown.status).toBe(404);
  expect(rejected.status).toBe(404);
  expect(unknown.body).toBe(rejected.body);
  expect(unknown.headers.get("content-type")).toBe(
    rejected.headers.get("content-type"),
  );
  // The Host and the Tenant answer through the same helper (`api/http/respond.ts`): every
  // header, framing included, is the same.
  expect(comparableHeaders(unknown.headers)).toEqual(comparableHeaders(rejected.headers));

  const ok = await hostGetJson(`${host.url}/v1/agents`, {
    headers: a.headers(),
  });
  expect(ok.status).toBe(200);
});
