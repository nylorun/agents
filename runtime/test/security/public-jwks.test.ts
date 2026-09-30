/**
 * The Tenant's public keys are public (design: Action endpoints §8.2): an Action endpoint that
 * holds no key reads them with `Nylorun-Tenant` alone. A credential that is sent is still
 * checked, and browsers still need a publishable key.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startEphemeralRuntime, type EphemeralRuntime } from "../../src/tenant/ephemeral.js";

let root: string;
let rt: EphemeralRuntime;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-public-jwks-"));
  rt = await startEphemeralRuntime({ hostRoot: root, browserAccess: true, model: { kind: "fixture" } });
});

afterAll(async () => {
  await rt?.close();
  await rm(root, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${rt.url}${path}`, {
    headers: { "nylorun-protocol": "2", "nylorun-tenant": rt.tenantId, ...headers },
  });

it("serves the JWKS with only the Tenant header", async () => {
  const open = await get("/v1/access/jwks");
  expect(open.status).toBe(200);
  const body = (await open.json()) as { keys: { kid: string; kty: string; crv: string }[] };
  expect(body.keys.length).toBeGreaterThan(0);
  expect(body.keys[0]).toMatchObject({ kty: "EC", crv: "P-256" });
});

it("still checks a credential that is sent, and still refuses browsers without a publishable key", async () => {
  expect((await get("/v1/access/jwks", { authorization: "Bearer not-a-real-key-000000000000" })).status).toBe(404);
  expect((await get("/v1/access/jwks", { origin: "https://app.example" })).status).toBe(403);
});

it("serves nothing else without a credential", async () => {
  for (const path of ["/v1/agents", "/v1/access/policy", "/v1/endpoints", "/v1/sessions"])
    expect((await get(path)).status, path).toBe(404);
});
