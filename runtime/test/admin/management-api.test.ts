/**
 * The Management API (protocol 8, A2): `/v1/tenant/keys`, and vaults and signing keys under
 * `/v1/tenant`, with a management key, through `@nylorun/admin`'s `createManagementClient`.
 * A management key issues application keys, never management keys. Application keys do not
 * reach the Management API, and the old paths (`/v1/vaults`, `/v1/access/signing-keys`) are
 * gone (protocol 8).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminError, createAdmin, createManagementClient } from "@nylorun/admin";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { runOperate } from "../../src/host/operate.js";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { isolatedTestDatabase } from "../support/store.js";

const closers: { close(): Promise<void> }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function startHost() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-management-"));
  roots.push(hostRoot);
  const database = await isolatedTestDatabase();
  const runtime = await startEphemeralRuntime({ hostRoot, retainRoot: true, database: database.sql });
  closers.push(runtime, { close: database.drop });
  const out: string[] = [];
  const code = await runOperate(["keys", "put", "ops", "--role", "management"], {
    env: { NYLORUN_DATABASE_URL: database.url },
    out: (line) => out.push(line),
    err: () => undefined,
  });
  expect(code).toBe(0);
  const managementKey = out[0]!;
  const admin = createManagementClient({ url: runtime.url, key: managementKey });
  const status = async (key: string, method: string, path: string) =>
    (
      await fetch(`${runtime.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
      })
    ).status;
  return { ...runtime, admin, managementKey, status };
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof AdminError ? { code: error.code, status: error.status } : error),
  );

describe("application keys through the Management API", () => {
  it("issues, rotates, lists and deletes application keys, and never a management key", async () => {
    const host = await startHost();
    const put = await host.admin.keys.put("backend");
    expect(put).toMatchObject({ id: "backend", role: "application", rotated: false });
    expect(await host.status(put.key, "GET", "/v1/agents")).toBe(200);
    // The new application key does not reach the Management API's new routes.
    expect(await host.status(put.key, "GET", "/v1/tenant/keys")).toBe(403);

    const rotated = await host.admin.keys.put("backend");
    expect(rotated.rotated).toBe(true);
    expect(await host.status(put.key, "GET", "/v1/agents")).toBe(404);

    const keys = await host.admin.keys.list();
    expect(keys.map(({ id, role }) => ({ id, role }))).toEqual(
      expect.arrayContaining([
        { id: "backend", role: "application" },
        { id: "ops", role: "management" },
        { id: "studio", role: "studio" },
      ]),
    );

    // A management key's name, studio and bootstrap are refused: only the machine manages them.
    expect(await refusal(host.admin.keys.put("ops"))).toMatchObject({ status: 400 });
    expect(await refusal(host.admin.keys.delete("ops"))).toMatchObject({ status: 400 });
    expect(await refusal(host.admin.keys.put("studio"))).toMatchObject({ status: 400 });
    expect(await refusal(host.admin.keys.put("bootstrap"))).toMatchObject({ status: 400 });
    expect(await refusal(host.admin.keys.put("Not_A_Key"))).toEqual({ code: "invalid_request", status: 400 });
    expect(JSON.stringify(keys)).not.toContain(rotated.key);
    expect(await host.status(host.managementKey, "GET", "/v1/tenant")).toBe(200);

    expect(await host.admin.keys.delete("backend")).toBe(true);
    expect(await host.admin.keys.delete("backend")).toBe(false);
    expect(await host.status(rotated.key, "GET", "/v1/agents")).toBe(404);
  });
});

describe("createAdmin", () => {
  it("checks /health, then reaches the Management API with a management key", async () => {
    const host = await startHost();
    const admin = createAdmin({ url: host.url, key: host.managementKey });
    expect(admin.source).toBe("options");
    expect((await admin.tenant.status()).tenant.id).toBe(host.tenantId);
    expect((await admin.keys.list()).map((key) => key.id)).toContain("ops");
    // An application key is the Runtime's to refuse, with the API it belongs to.
    await expect(
      createAdmin({ url: host.url, key: host.applicationKey }).tenant.status(),
    ).rejects.toMatchObject({ code: "key_role_mismatch", status: 403 });
  });
});

describe("the Management API's groups", () => {
  it("reads the Tenant, its model, budgets and settings", async () => {
    const host = await startHost();
    expect((await host.admin.tenant.status()).tenant.id).toBe(host.tenantId);
    expect(await host.admin.models.get()).toBeDefined();
    expect(await host.admin.models.budgets.put({ budgets: [] })).toEqual({ budgets: [] });
    expect(await host.admin.settings.sandbox.get()).toBeDefined();
    expect(await host.admin.settings.artifacts.get()).toBeDefined();
  });

  it("manages installation vaults and their credentials under /v1/tenant/vaults", async () => {
    const host = await startHost();
    const vault = await host.admin.vaults.create({
      name: "tools",
      idempotencyKey: "tools",
      scope: "installation",
    });
    expect((await host.admin.vaults.list()).map((v) => v.id)).toContain(vault.id);
    const credential = await host.admin.vaults.credentials.create(vault.id, {
      name: "linear",
      idempotencyKey: "linear",
      auth: { type: "bearer", url: "https://mcp.example.com/mcp", token: "secret" },
    });
    expect((await host.admin.vaults.credentials.list(vault.id)).map((c) => c.id)).toEqual([
      credential.id,
    ]);
    await host.admin.vaults.credentials.rotate(vault.id, credential.id, {
      idempotencyKey: "rotate",
      auth: { type: "bearer", token: "secret-2" },
    });
    expect(await host.admin.vaults.credentials.delete(vault.id, credential.id)).toEqual({
      id: credential.id,
    });
    expect(await host.admin.vaults.delete(vault.id)).toEqual({ id: vault.id });
    // Application keys never reach the vaults, and the old paths are gone (protocol 8).
    expect(await host.status(host.applicationKey, "GET", "/v1/tenant/vaults")).toBe(403);
    expect(await host.status(host.applicationKey, "GET", "/v1/vaults")).toBe(404);
    expect(await host.status(host.managementKey, "GET", "/v1/vaults")).toBe(404);
  });

  it("lists and rotates signing keys under /v1/tenant/signing-keys", async () => {
    const host = await startHost();
    const before = await host.admin.signingKeys.list();
    expect(before.map((key) => key.state).sort()).toEqual(["current", "standby"]);
    const after = await host.admin.signingKeys.rotate();
    const current = after.find((key) => key.state === "current");
    expect(current?.id).toBe(before.find((key) => key.state === "standby")?.id);
    expect(await host.status(host.applicationKey, "GET", "/v1/tenant/signing-keys")).toBe(403);
    // The old path is gone (protocol 8).
    expect(await host.status(host.applicationKey, "GET", "/v1/access/signing-keys")).toBe(404);
    expect(await host.status(host.managementKey, "GET", "/v1/access/signing-keys")).toBe(404);
  });
});
