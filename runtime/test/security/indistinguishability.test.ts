/**
 * G6 — Indistinguishability of another Tenant named and a Tenant not opened. A rejected
 * credential is told apart since protocol 9: `401` with a `Bearer` challenge (OAuth 2.1 §5.3).
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

it("G6: credential-rejected is a 401 challenge, unlike another Tenant named (protocol 9)", async () => {
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
  expect(unknown.status).toBe(404);
  expect(JSON.parse(unknown.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(unknown.headers.get("www-authenticate")).toBeNull();
  expect(rejected.status).toBe(401);
  expect(JSON.parse(rejected.body)).toEqual({
    status: "rejected",
    code: "credential_invalid",
    message: "The credential is not valid here",
  });
  expect(rejected.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');

  const ok = await hostGetJson(`${host.url}/v1/agents`, {
    headers: a.headers(),
  });
  expect(ok.status).toBe(200);
});
