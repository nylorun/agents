/**
 * G6 — Indistinguishability of unknown / quarantined / credential-rejected.
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

it("G6: unknown and quarantined Host responses are byte-identical", async () => {
  const openId = newTenantId();
  const quarantinedId = newTenantId();
  const module = createFakeModule({
    tenants: [
      { id: openId, name: "open", state: "open" },
      {
        id: quarantinedId,
        name: "q",
        state: "quarantined",
        quarantine: {
          code: "kek-missing",
          message: "vault key missing",
          repair: "nylo tenant status",
        },
      },
    ],
  });
  const { url } = await startTestHost({ module });

  const unknown = await getRaw(`${url}/v1/agents`, {
    headers: hostTenantHeaders(newTenantId()),
  });
  const quarantined = await getRaw(`${url}/v1/agents`, {
    headers: hostTenantHeaders(quarantinedId),
  });

  expect(unknown.status).toBe(404);
  expect(quarantined.status).toBe(404);
  expect(JSON.parse(unknown.body)).toEqual(OPAQUE_NOT_FOUND);
  expect(unknown.status).toBe(quarantined.status);
  expect(unknown.body).toBe(quarantined.body);
  expect(comparableHeaders(unknown.headers)).toEqual(
    comparableHeaders(quarantined.headers),
  );
});

it("G6: credential-rejected matches unknown status and body (D5)", async () => {
  const host = await startSecurityHost();
  const [a, b] = host.tenants;

  const unknown = await getRaw(`${host.url}/v1/agents`, {
    headers: tenantHeaders(newTenantId(), a.applicationKey),
  });
  const rejected = await getRaw(`${host.url}/v1/agents`, {
    headers: tenantHeaders(a.id, b.applicationKey),
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
