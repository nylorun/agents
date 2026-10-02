/**
 * F4.2, the keys service: with it (`NYLORUN_TEST_MODEL_GATE=http`: a gates service on 127.0.0.1
 * that also runs keys), the Tenant never reads the vault key. Vault writes, token signing and
 * signing-key rotation run in the gate, and the Tenant API answers exactly what it answered when
 * they ran in its own process: the same results, statuses, codes and details.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { newTenantId } from "@nylorun/core/compatibility";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { httpKeys } from "../../src/keys/client.js";
import { KEYS_PATH } from "../../src/keys/contract.js";
import { HttpError } from "../../src/tenant/http.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { startGates } from "../../src/host/gates.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "keys-app-token-aaaaaaaaaaaaaaaaa";
const headers = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
  [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
};
const quiet = { info() {}, warn() {}, error() {} } as never;
const token = "cd".repeat(32);

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

async function boot(): Promise<Started> {
  const runtime = await startTestTenant({ applicationKey: APP });
  cleanup.push(() => runtime.close());
  return runtime;
}

async function call(runtime: Started, method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

describe("the Tenant API through the keys service", () => {
  it("creates and rotates a credential, and keeps a vault error's status", async () => {
    const runtime = await boot();
    const vault = await call(runtime, "POST", "/v1/vaults", {
      requestId: "v1",
      idempotencyKey: "v1",
      name: "GitHub",
      ownerUserId: "ada",
    });
    expect(vault.status).toBe(200);
    const created = await call(runtime, "POST", `/v1/vaults/${vault.body.id}/credentials`, {
      requestId: "c1",
      idempotencyKey: "c1",
      name: "token",
      auth: { type: "bearer", url: "https://mcp.example.invalid/mcp", token: "first-secret-value" },
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain("first-secret-value");
    const rotated = await call(
      runtime,
      "POST",
      `/v1/vaults/${vault.body.id}/credentials/${created.body.id}`,
      { requestId: "r1", idempotencyKey: "r1", auth: { type: "bearer", token: "second-secret-value" } },
    );
    expect(rotated.status).toBe(200);
    // A vault error raised in the gateway keeps its status across the hop.
    const missing = await call(runtime, "POST", `/v1/vaults/${vault.body.id}/credentials/cred_missing`, {
      requestId: "r2",
      idempotencyKey: "r2",
      auth: { type: "bearer", token: "x-secret-value" },
    });
    expect(missing.status).toBe(404);
  });

  it("sets and selects the host model", async () => {
    const runtime = await boot();
    const put = await call(runtime, "PUT", "/v1/tenant/model", {
      requestId: "m1",
      idempotencyKey: "m1",
      provider: "custom",
      model: "first",
      baseUrl: "https://models.example.invalid/v1",
      auth: { type: "api_key", key: "host-model-key-value" },
    });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain("host-model-key-value");
    const selected = await call(runtime, "PUT", "/v1/tenant/model/selection", {
      requestId: "m2",
      idempotencyKey: "m2",
      provider: "custom",
      model: "second",
      baseUrl: "https://models.example.invalid/v1",
    });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({ model: "second" });
  });

  it("signs subject tokens that verify against the published JWKS", async () => {
    const runtime = await boot();
    // A fresh Tenant has no keys: the anonymous JWKS asks the keys service to create them.
    const jwks = await call(runtime, "GET", "/v1/access/jwks");
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys).toHaveLength(2);
    expect(
      (await call(runtime, "PUT", "/v1/access/policy", {
        requestId: "p1",
        policy: {
          version: 1,
          roles: { user: { scopes: ["sessions:own"], agents: "*" } },
          anon: { scopes: [], agents: [] },
          tokens: { maxTtlSeconds: 600 },
        },
      })).status,
    ).toBe(200);
    const minted = await call(runtime, "POST", "/v1/tokens", {
      requestId: "t1",
      subject: "app:ada",
      role: "user",
      ttlSeconds: 300,
    });
    expect(minted.status).toBe(200);
    expect(decodeProtectedHeader(minted.body.token)).toMatchObject({
      alg: "ES256",
      typ: "nylorun-subject+jwt",
      kid: minted.body.keyId,
    });
    const verified = await jwtVerify(minted.body.token, createLocalJWKSet({ keys: jwks.body.keys }));
    expect(verified.payload).toMatchObject({ sub: "app:ada", aud: "nylorun", role: "user" });
  });

  it("rotates signing keys, and keeps a refusal's code and details", async () => {
    const runtime = await boot();
    expect((await call(runtime, "GET", "/v1/access/signing-keys")).status).toBe(200);
    const first = await call(runtime, "POST", "/v1/access/signing-keys/rotate", { requestId: "k1" });
    expect(first.status).toBe(200);
    expect(first.body.keys.map((key: { state: string }) => key.state).sort()).toEqual([
      "current",
      "previous",
      "standby",
    ]);
    const second = await call(runtime, "POST", "/v1/access/signing-keys/rotate", { requestId: "k2" });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: "request_rejected",
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });
});

describe("the keys service's hop", () => {
  it("answers 503 keys_unavailable when the gateway refuses the token or is down", async () => {
    const server = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      vaults: { open: async () => ({ tenantId: newTenantId() }) as never },
      keys: true,
      drainMs: 0,
    });
    cleanup.push(() => server.close());
    const wrong = httpKeys({ url: server.url, token: "00".repeat(32) });
    await expect(wrong.ensureSigningKeys()).rejects.toMatchObject({
      status: 503,
      rejection: { code: "keys_unavailable" },
    });
    const down = httpKeys({ url: "http://127.0.0.1:9", token });
    await expect(down.ensureSigningKeys()).rejects.toBeInstanceOf(HttpError);
    const unknown = await fetch(new URL(`${KEYS_PATH}/readKek`, server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ args: [] }),
    });
    expect(unknown.status).toBe(404);
  });

  it("keeps the gateway unready until the vault key file is there", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-keys-ready-"));
    cleanup.push(() => rm(hostRoot, { recursive: true, force: true }));
    const server = await startGates({
      gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
      logger: quiet,
      hostRoot,
      vaults: { open: async () => ({ tenantId: newTenantId() }) as never },
      keys: true,
      drainMs: 0,
    });
    cleanup.push(() => server.close());
    expect((await fetch(new URL("/ready", server.url))).status).toBe(503);
    const key = tenantPaths(hostRoot).kek;
    mkdirSync(dirname(key), { recursive: true });
    await writeFile(key, `${Buffer.alloc(32, 1).toString("base64")}\n`, { mode: 0o600 });
    expect((await fetch(new URL("/ready", server.url))).status).toBe(200);
  });
});
