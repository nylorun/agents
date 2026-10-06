/**
 * The Tenant's public keys are public: a verifier of the Runtime's tokens that holds no key
 * reads them with `Nylorun-Tenant` alone. A credential that is sent is still
 * checked, and an application key is still refused from a browser.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { startEphemeralRuntime, type EphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { testPool } from "../support/store.js";

let root: string;
let rt: EphemeralRuntime;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-public-jwks-"));
  rt = await startEphemeralRuntime({ database: testPool(), hostRoot: root, model: { kind: "fixture" } });
});

afterAll(async () => {
  await rt?.close();
  await rm(root, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${rt.url}${path}`, {
    headers: { "nylorun-protocol": String(PROTOCOL_VERSION), "nylorun-tenant": rt.tenantId, ...headers },
  });

it("serves the JWKS with only the Tenant header", async () => {
  const open = await get("/v1/access/jwks");
  expect(open.status).toBe(200);
  const body = (await open.json()) as { keys: { kid: string; kty: string; crv: string }[] };
  expect(body.keys.length).toBeGreaterThan(0);
  expect(body.keys[0]).toMatchObject({ kty: "EC", crv: "P-256" });
});

it("still checks a credential that is sent, and refuses an application key from a browser", async () => {
  expect((await get("/v1/access/jwks", { authorization: "Bearer not-a-real-key-000000000000" })).status).toBe(401);
  // A browser with no credential reads public keys too (protocol 7); CORS is the proxy's.
  const browser = await get("/v1/access/jwks", { origin: "https://app.example" });
  expect(browser.status).toBe(200);
  expect(browser.headers.get("access-control-allow-origin")).toBeNull();
  expect(
    (await get("/v1/access/jwks", { origin: "https://app.example", authorization: `Bearer ${rt.applicationKey}` }))
      .status,
  ).toBe(403);
});

it("serves nothing else without a credential", async () => {
  for (const path of ["/v1/agents", "/v1/tenant/signing-keys", "/v1/sessions"])
    expect((await get(path)).status, path).toBe(401);
});
