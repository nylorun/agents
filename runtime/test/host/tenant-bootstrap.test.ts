/**
 * A Host and its Tenant (tenancy.md §4–§5, plan P9): the Host creates its Tenant in its
 * database on first start and serves it again after a restart; the derived principals it is
 * configured with reach it without naming it; a database it may not open leaves it not ready,
 * with the cause in `/v1/admin/status`, and every Tenant request gets the opaque 404.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { deriveStudioToken, deriveTenantKey } from "@nylorun/admin";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import { AdminStatusSchema } from "@nylorun/core/contracts";
import { createHost } from "../../src/host/create-host.js";
import { createHostLogger } from "../../src/host/logger.js";
import { OPAQUE_NOT_FOUND } from "../../src/host/http.js";
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import { POSTGRES_SCHEMA_VERSION } from "../../src/store/postgres/migrations/index.js";
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
  options: { adminKey?: string; tenantId?: string; name?: string; derived?: readonly string[] } = {},
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
        principals: hostPrincipals({ adminKey, derived: options.derived ?? ["project"] }),
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
    credentials: { adminKey },
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
  const admin = { authorization: `Bearer ${adminKey}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
  return {
    url: host.url,
    adminKey,
    lines,
    close,
    async status() {
      const response = await fetch(`${host.url}/v1/admin/status`, { headers: admin });
      return AdminStatusSchema.parse(await response.json());
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
  const project = deriveTenantKey(first.adminKey, tenantId, "project");
  expect((await again.tenant(project)).status).toBe(200);
});

it("registers the Studio and derived principals; their keys reach the Tenant without naming it", async () => {
  const { sql } = await tenantTestDatabase();
  const host = await startHost(sql, { derived: ["project", "babai"] });
  const { tenant } = await host.status();
  const id = tenant.id!;
  for (const key of [
    deriveTenantKey(host.adminKey, id, "project"),
    deriveTenantKey(host.adminKey, id, "babai"),
    deriveStudioToken(host.adminKey, id),
  ]) {
    const response = await host.tenant(key);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenant: { id } });
  }
  // A protocol 4 client naming the Tenant is served; naming another is the opaque 404.
  const project = deriveTenantKey(host.adminKey, id, "project");
  expect((await host.tenant(project, { [TENANT_HEADER]: id })).status).toBe(200);
  const other = await host.tenant(project, { [TENANT_HEADER]: newTenantId() });
  expect(other.status).toBe(404);
  expect(await other.json()).toEqual(OPAQUE_NOT_FOUND);
  // Principals it was not configured with reach nothing.
  expect((await host.tenant(deriveTenantKey(host.adminKey, id, "smoke"))).status).toBe(404);

  // Configured later, a derived principal is added on the next start.
  await host.close();
  const restarted = await startHost(sql, { adminKey: host.adminKey, derived: ["project", "smoke"] });
  expect((await restarted.tenant(deriveTenantKey(host.adminKey, id, "smoke"))).status).toBe(200);
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
  await sql`INSERT INTO nylorun.schema_version (version, name) VALUES (${POSTGRES_SCHEMA_VERSION + 1}, 'future')`;
  const host = await startHost(sql);
  expect(await host.ready()).toBe(503);
  expect((await host.status()).tenant).toMatchObject({
    id: tenantId,
    state: "unavailable",
    cause: { code: "schema-too-new", repair: expect.stringContaining("newer") },
  });
  expect((await host.tenant(deriveTenantKey(first.adminKey, tenantId, "project"))).status).toBe(404);
});
