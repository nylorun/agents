/**
 * Key roles (protocol 8, A1): a management key, issued only with `nylorun-operate` on the
 * Tenant's machine or from `NYLORUN_MANAGEMENT_KEY_FILE`, reaches the Management API
 * (`/v1/tenant/*`) and `/v1/me` as itself, and nothing else. Studio's key holds role `studio`.
 * Since the cut (protocol 8), application keys no longer reach `/v1/tenant/*`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { createHmac } from "node:crypto";
import { hashToken, mintBearerToken } from "../../src/core/bearer.js";
import { EXIT_REFUSED, EXIT_TENANT, EXIT_USAGE, runOperate } from "../../src/host/operate.js";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { deriveStudioKey, hostPrincipals } from "../../src/tenant/principals.js";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { isolatedTestDatabase } from "../support/store.js";

const closers: { close(): Promise<void> }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function startHost() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-key-roles-"));
  roots.push(hostRoot);
  const database = await isolatedTestDatabase();
  const runtime = await startEphemeralRuntime({ hostRoot, retainRoot: true, database: database.sql });
  closers.push(runtime, { close: database.drop });
  const operate = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runOperate(argv, {
      env: { NYLORUN_DATABASE_URL: database.url },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err };
  };
  const call = async (
    key: string,
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        ...headers,
      },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { ...runtime, database, operate, call };
}

describe("nylorun-operate keys", () => {
  it("puts a management key that reaches the Management API and /v1/me only", async () => {
    const host = await startHost();
    const put = await host.operate("keys", "put", "ops", "--role", "management");
    expect(put.code).toBe(0);
    const key = put.out[0]!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    expect((await host.call(key, "GET", "/v1/tenant")).status).toBe(200);
    expect((await host.call(key, "GET", "/v1/tenant/budgets")).status).toBe(200);
    expect(await host.call(key, "GET", "/v1/me")).toMatchObject({
      status: 200,
      body: { scopes: [], agents: [], via: "management:ops" },
    });
    // The Runtime API refuses it, naming the other API.
    expect(await host.call(key, "GET", "/v1/sessions")).toMatchObject({
      status: 403,
      body: { code: "key_role_mismatch" },
    });
    expect((await host.call(key, "GET", "/v1/agents")).status).toBe(403);
    // It acts as itself, never for a subject, and never from a browser.
    expect(
      await host.call(key, "GET", "/v1/tenant", { "nylorun-subject": "u:priya" }),
    ).toMatchObject({ status: 403, body: { code: "subject_invalid" } });
    expect(
      await host.call(key, "GET", "/v1/tenant", { origin: "https://evil.example" }),
    ).toMatchObject({ status: 403, body: { code: "origin_rejected" } });
  });

  it("lists keys with their roles, and keeps a key's role when it is rotated", async () => {
    const host = await startHost();
    expect((await host.operate("keys", "put", "ops", "--role", "management")).code).toBe(0);
    expect((await host.operate("keys", "put", "backend")).code).toBe(0);
    const listed = await host.operate("keys", "list", "--json");
    expect(listed.code).toBe(0);
    const { keys } = JSON.parse(listed.out[0]!) as { keys: { id: string; role: string }[] };
    expect(keys.map(({ id, role }) => ({ id, role }))).toEqual(
      expect.arrayContaining([
        { id: "backend", role: "application" },
        { id: "ops", role: "management" },
        { id: "studio", role: "studio" },
      ]),
    );

    // Same id, other role: refused, and the key keeps working.
    const first = (await host.operate("keys", "put", "solo", "--role", "management")).out[0]!;
    const clash = await host.operate("keys", "put", "solo");
    expect(clash.code).toBe(EXIT_REFUSED);
    expect(clash.err.join("\n")).toMatch(/not an application key/);
    expect((await host.call(first, "GET", "/v1/tenant")).status).toBe(200);

    const rotated = await host.operate("keys", "put", "solo", "--role", "management", "--json");
    expect(JSON.parse(rotated.out[0]!)).toMatchObject({ id: "solo", role: "management", rotated: true });
    expect((await host.call(first, "GET", "/v1/tenant")).status).toBe(404);

    expect((await host.operate("keys", "rm", "solo")).code).toBe(0);
    expect((await host.operate("keys", "rm", "studio")).code).toBe(EXIT_REFUSED);
    expect((await host.operate("keys", "put", "bootstrap", "--role", "management")).code).toBe(
      EXIT_REFUSED,
    );
  });

  it("refuses bad usage, and a database without a Tenant", async () => {
    const host = await startHost();
    expect((await host.operate("keys")).code).toBe(EXIT_USAGE);
    expect((await host.operate("keys", "put", "x", "--role", "studio")).code).toBe(EXIT_USAGE);
    const empty = await isolatedTestDatabase();
    closers.push({ close: empty.drop });
    const code = await runOperate(["keys", "list"], {
      env: { NYLORUN_DATABASE_URL: empty.url },
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(EXIT_TENANT);
  });
});

describe("application keys and Studio's key", () => {
  it("application keys no longer reach /v1/tenant/* (protocol 8), and Studio's key has role studio", async () => {
    const host = await startHost();
    expect(await host.call(host.applicationKey, "GET", "/v1/tenant")).toMatchObject({
      status: 403,
      body: { code: "key_role_mismatch" },
    });
    // Nor when acting for a subject.
    expect(
      await host.call(host.applicationKey, "GET", "/v1/tenant", {
        "nylorun-subject": "u:priya",
        "nylorun-scopes": "tenant:settings",
      }),
    ).toMatchObject({ status: 403, body: { code: "key_role_mismatch" } });
    expect(await host.call(host.applicationKey, "GET", "/v1/me")).toMatchObject({
      status: 200,
      body: { via: `application:${host.principalId}` },
    });
    const listed = await host.operate("keys", "list", "--json");
    expect(JSON.parse(listed.out[0]!).keys).toContainEqual(
      expect.objectContaining({ id: "studio", role: "studio" }),
    );
  });
});

describe("the bootstrap key", () => {
  it("is registered as a management key, and replaced when the file changes", async () => {
    const database = await isolatedTestDatabase();
    closers.push({ close: database.drop });
    const open = (bootstrapKey: string) =>
      openTenantDatabase({
        sql: database.sql,
        create: { name: "t", principals: hostPrincipals({ adminKey: "a".repeat(64), bootstrapKey }) },
      });
    const first = mintBearerToken();
    const opened = await open(first);
    const row = await opened.store.tx((t) => t.principalById("bootstrap"));
    expect(row?.role).toBe("management");
    const second = mintBearerToken();
    await open(second);
    const after = await opened.store.tx((t) => t.principalById("bootstrap"));
    expect(after?.tokenHash).not.toBe(row?.tokenHash);
    expect(after?.role).toBe("management");
  });
});

describe("Studio's key v2", () => {
  it("replaces a v1 hash (derived with the Tenant id) when the Host opens the database", async () => {
    const database = await isolatedTestDatabase();
    closers.push({ close: database.drop });
    const adminKey = "a".repeat(64);
    // The v1 derivation: HMAC-SHA256(adminKey, "nylorun/studio/v1" NUL tenantId).
    const v1 = (tenantId: string) =>
      createHmac("sha256", adminKey).update(`nylorun/studio/v1\0${tenantId}`).digest("hex");
    const opened = await openTenantDatabase({
      sql: database.sql,
      create: {
        name: "t",
        principals: (tenantId) => [
          { id: "studio", role: "studio", credentialHash: hashToken(v1(tenantId)) },
        ],
      },
    });
    const old = await opened.store.tx((t) => t.principalById("studio"));
    expect(old?.tokenHash).toBe(hashToken(v1(opened.envelope.id)));

    await openTenantDatabase({
      sql: database.sql,
      create: { name: "t", principals: hostPrincipals({ adminKey }) },
    });
    const after = await opened.store.tx((t) => t.principalById("studio"));
    expect(after?.tokenHash).toBe(hashToken(deriveStudioKey(adminKey)));
    expect(after?.role).toBe("studio");
  });
});
