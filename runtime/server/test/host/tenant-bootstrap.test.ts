/**
 * A Host and its Tenant (tenancy.md §4–§5, plan P9): the Host creates its Tenant in its
 * database on first start and serves it again after a restart; the Studio key the admin key
 * derives reaches it without naming it, and no other key is derived (protocol 7); a database it may not open leaves it not ready,
 * with the cause in the Tenant module's state (`nylorun-operate status` reads it from the database;
 * `operate-status.test.ts`), and every Tenant request gets the opaque 404.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { deriveStudioToken } from "@nylorun/admin";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import { hashToken } from "../../src/core/bearer.js";
import { createHost } from "../../src/host/create-host.js";
import { createHostLogger } from "../../src/host/logger.js";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import { createTenantModule } from "../../src/tenant/module.js";
import { hostPrincipals } from "../../src/tenant/principals.js";
import { openTenantRuntime } from "../../src/tenant/runtime.js";
import { createPostgresTenantOpener } from "../../src/tenant/store-pg.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { emptyTestDatabase, tenantTestDatabase } from "../support/database.js";
import { configForRoot } from "../tenant/support.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A Host wired as `host/main.ts` wires it, on `sql`, with the Tenant settings given. */
async function startHost(
  sql: PostgresClient,
  options: { adminKey?: string; tenantId?: string; name?: string } = {},
) {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-bootstrap-"));
  const adminKey = options.adminKey ?? randomBytes(32).toString("hex");
  const lines: string[] = [];
  const logger = createHostLogger((line) => lines.push(line));
  const streams = new MemoryStreams();
  const module = createTenantModule({
    open: createPostgresTenantOpener({
      hostRoot,
      sql,
      create: {
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        name: options.name ?? "default",
        principals: hostPrincipals({ adminKey }),
      },
      configFor: (id) => ({ ...configForRoot(hostRoot)(id), model: { kind: "scripted", output: "ok" } }),
      logger,
      openRuntime: (config, opened) =>
        openTenantRuntime(config, { createKekIfMissing: true, streams, ...opened }),
    }),
    logger,
  });
  const host = createHost({
    hostRoot,
    module,
    config: { hostId: `host_${newTenantId().slice(3)}`, host: "127.0.0.1", port: 0 },
    logger,
    coreVersion: "test",
  });
  await host.listen();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await host.close();
    await streams.close();
    await rm(hostRoot, { recursive: true, force: true });
  };
  closers.push(close);
  return {
    url: host.url,
    adminKey,
    lines,
    close,
    /** The Host's Tenant: open, or why not. */
    async status() {
      return { tenant: module.tenant() };
    },
    async tenant(key: string, extra: Record<string, string> = {}) {
      return fetch(`${host.url}/v1/tenant`, {
        headers: { authorization: `Bearer ${key}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...extra },
      });
    },
    async ready() {
      return (await fetch(`${host.url}/ready`)).status;
    },
  };
}

it("creates its Tenant on first start, and serves the same one after a restart", async () => {
  const { sql } = await tenantTestDatabase();
  const tenantId = newTenantId();
  const first = await startHost(sql, { tenantId, name: "my-app" });
  expect(await first.ready()).toBe(200);
  const created = await first.status();
  expect(created.tenant).toMatchObject({ id: tenantId, name: "my-app", state: "open" });
  expect(created.tenant.cause).toBeUndefined();
  expect(first.lines.join("\n")).toContain("tenant created");
  await first.close();

  // Another id and name configured later change nothing: the database holds its Tenant.
  const again = await startHost(sql, { adminKey: first.adminKey, tenantId: newTenantId(), name: "other" });
  expect((await again.status()).tenant).toMatchObject({ id: tenantId, name: "my-app", state: "open" });
  expect(again.lines.join("\n")).not.toContain("tenant created");
  const studio = deriveStudioToken(first.adminKey);
  expect((await again.tenant(studio)).status).toBe(200);
});

it("registers the Studio principal; its key reaches the Tenant without naming it, and nothing else derived does", async () => {
  const { sql } = await tenantTestDatabase();
  const host = await startHost(sql);
  const { tenant } = await host.status();
  const id = tenant.id!;
  const studio = deriveStudioToken(host.adminKey);
  const response = await host.tenant(studio);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ tenant: { id } });
  // A protocol 4 client naming the Tenant is served; naming another is the opaque 404.
  expect((await host.tenant(studio, { [TENANT_HEADER]: id })).status).toBe(200);
  const other = await host.tenant(studio, { [TENANT_HEADER]: newTenantId() });
  expect(other.status).toBe(404);
  expect(await other.json()).toEqual(OPAQUE_NOT_FOUND);
  // Protocol 6's derived project key is no longer registered.
  const derived = createHmac("sha256", host.adminKey)
    .update(Buffer.from(`nylorun/principal/v1\u0000project\u0000${id}`, "utf8"))
    .digest("hex");
  expect((await host.tenant(derived)).status).toBe(401);
});

it("keeps a principal an earlier Runtime registered as an ordinary key", async () => {
  const { sql } = await tenantTestDatabase();
  const host = await startHost(sql);
  const id = (await host.status()).tenant.id!;
  await host.close();
  // A derived principal registered by a protocol 6 Host stays in the principals table.
  const key = "b".repeat(64);
  await sql`INSERT INTO nylorun.principals (id, role, token_hash, created_at)
    VALUES ('legacy', 'application', ${hashToken(key)}, ${new Date().toISOString()})`;
  const restarted = await startHost(sql, { adminKey: host.adminKey });
  const me = await fetch(`${restarted.url}/v1/me`, {
    headers: { authorization: `Bearer ${key}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
  });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ via: "application:legacy" });
  // An application key: the Management API turns it away (protocol 8).
  const response = await restarted.tenant(key);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "key_role_mismatch" });
  expect((await restarted.status()).tenant).toMatchObject({ id });
});

it("refuses a database of the old layout: not ready, the cause in the status, the opaque 404", async () => {
  const { sql } = await emptyTestDatabase();
  const old = newTenantId();
  await sql.unsafe(`CREATE SCHEMA tenant_${old}`);
  const host = await startHost(sql);
  expect(await host.ready()).toBe(503);
  const { tenant } = await host.status();
  expect(tenant).toMatchObject({
    id: null,
    name: null,
    state: "unavailable",
    cause: { code: "database-layout-old", message: expect.stringContaining("starts fresh") },
  });
  const response = await host.tenant("any-key-at-all-0000000000");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual(OPAQUE_NOT_FOUND);
  expect(host.lines.join("\n")).toContain("database-layout-old");
});

it("refuses a database migrated by a newer Runtime, naming its Tenant", async () => {
  const { sql } = await tenantTestDatabase();
  const tenantId = newTenantId();
  const first = await startHost(sql, { tenantId });
  await first.close();
  // A migration of a newer Runtime in the journal.
  await sql`INSERT INTO nylorun.__drizzle_migrations (hash, created_at) VALUES ('future', 0)`;
  const host = await startHost(sql);
  expect(await host.ready()).toBe(503);
  expect((await host.status()).tenant).toMatchObject({
    id: tenantId,
    state: "unavailable",
    cause: { code: "schema-too-new", repair: expect.stringContaining("newer") },
  });
  expect((await host.tenant(deriveStudioToken(first.adminKey))).status).toBe(404);
});
