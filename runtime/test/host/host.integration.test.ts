/**
 * The Host composed the way `host/main.ts` composes it, against the test stack: the
 * infrastructure clients from `createInfra`, the Host execution, and the Postgres Tenant
 * store. `/ready` follows discovery and the infrastructure checks, the Admin API creates and
 * serves a Postgres Tenant, and shutdown ends the infrastructure clients.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  newTenantId,
} from "@nylorun/core/compatibility";
import { MemoryExecution } from "../../src/execution/memory.js";
import { createHost } from "../../src/host/create-host.js";
import { createHostExecution } from "../../src/host/execution.js";
import { createHostLogger } from "../../src/host/logger.js";
import { parseStackConfig } from "../../src/host/stack-config.js";
import { createInfra } from "../../src/infra/index.js";
import { createPostgresClient } from "../../src/store/postgres/connect.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { createTenantModule } from "../../src/tenant/module.js";
import { openTenantRuntime } from "../../src/tenant/runtime.js";
import { createPostgresTenantStore } from "../../src/tenant/store-pg.js";
import type { TenantConfig } from "../../src/tenant/types.js";
import { configForRoot } from "../tenant/support.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import { ADMIN_KEY, adminHeaders, freePort, getJson } from "./support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

function stack(overrides: Record<string, string> = {}) {
  const endpoints = stackEndpoints();
  return parseStackConfig(
    {
      NYLORUN_DATABASE_URL: endpoints.postgres.url,
      NYLORUN_RESTATE_INGRESS_URL: endpoints.restate.ingressUrl,
      NYLORUN_RESTATE_ADMIN_URL: endpoints.restate.adminUrl,
      NYLORUN_S2_ENDPOINT: endpoints.s2.endpoint,
      NYLORUN_S2_TOKEN: "ignored",
      ...overrides,
    },
    // Core serves no Worker endpoint; the Host execution here is in-process.
    ["--service", "core"],
  );
}

async function startHost(options: { overrides?: Record<string, string>; gate?: Promise<void> } = {}) {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-host-pg-"));
  cleanup.push(() => rm(hostRoot, { recursive: true, force: true }));
  const infra = createInfra(stack(options.overrides));
  cleanup.push(() => infra.close());
  const logger = createHostLogger(() => {});
  const configFor = (id: string): TenantConfig => ({
    ...configForRoot(hostRoot)(id),
    model: { kind: "scripted", output: "ok" },
  });
  const steps: string[] = [];
  const hostExecution = createHostExecution({
    execution: new MemoryExecution(),
    services: new Set(["core", "loop"] as const),
    resolve: (tenantId) => module.worker(tenantId),
  });
  const streams = new MemoryStreams();
  const store = createPostgresTenantStore({
    hostRoot,
    sql: infra.database!,
    configFor,
    openRuntime: (config, opened) =>
      openTenantRuntime(config, {
        execution: hostExecution.tenantExecution,
        streams,
        createKekIfMissing: true,
        ...opened,
      }),
  });
  const base = createTenantModule({
    store,
    logger,
    onDeleted: async (id) => {
      await hostExecution.disarm(id);
      await streams.deleteTenant(id);
    },
  });
  const gate = options.gate;
  const module = gate
    ? Object.assign(Object.create(base) as typeof base, {
        async start() {
          await gate;
          await base.start();
        },
      })
    : base;
  const config = { hostId: "host_0123456789abcdefghjkmnpq", host: "127.0.0.1", port: await freePort() };
  const host = createHost({
    hostRoot,
    module,
    config,
    credentials: { adminKey: ADMIN_KEY },
    logger,
    coreVersion: "test",
    ...(infra.readiness ? { readiness: infra.readiness } : {}),
    shutdown: {
      beforeTenants: async () => {
        steps.push("worker");
        await hostExecution.stop();
      },
      afterTenants: async () => {
        steps.push("infra");
        await infra.close();
      },
    },
  });
  cleanup.push(() => host.close());
  await hostExecution.start();
  const listening = host.listen();
  return { host, infra, listening, steps, module: base };
}

async function waitForUrl(host: { url: string }) {
  for (let i = 0; i < 100 && !host.url; i++) await new Promise((r) => setTimeout(r, 10));
  return host.url;
}

describe.skipIf(!STACK_ENABLED)("Host on Postgres, Restate and S2", () => {
  it("/ready is 503 until discovery finishes, then 200 with every infrastructure check", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { host, listening } = await startHost({ gate });
    const url = await waitForUrl(host);
    const before = await getJson(`${url}/ready`);
    expect(before.status).toBe(503);
    expect(before.body).toMatchObject({
      status: "not_ready",
      checks: { listener: true, discovery: false, postgres: true, restate: true, s2: true },
    });
    open();
    await listening;
    const after = await getJson(`${url}/ready`);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      status: "ready",
      checks: { listener: true, discovery: true, postgres: true, restate: true, s2: true },
    });
  });

  it("/ready is 503 naming the check while a dependency is unreachable", async () => {
    const { host, listening } = await startHost({
      overrides: { NYLORUN_S2_ENDPOINT: `http://127.0.0.1:${await freePort()}` },
    });
    await listening;
    const ready = await getJson(`${host.url}/ready`);
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ checks: { postgres: true, s2: false } });
  });

  it("creates and serves a Postgres Tenant, and admin shutdown ends the infrastructure", async () => {
    const { host, listening, infra, steps } = await startHost();
    await listening;
    const applicationKey = randomBytes(32).toString("hex");
    const tenantId = newTenantId();
    cleanup.push(async () => {
      const sql = createPostgresClient(stackEndpoints().postgres.url, { max: 1 });
      await sql`DROP SCHEMA IF EXISTS ${sql(tenantSchemaName(tenantId))} CASCADE`;
      await sql.end({ timeout: 5 });
    });
    const created = await getJson(`${host.url}/v1/admin/tenants`, {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        name: "pg",
        principalId: "principal_pg",
        credentialHash: createHash("sha256").update(applicationKey).digest("hex"),
        idempotencyKey: randomBytes(16).toString("hex"),
      }),
    });
    expect(created.status).toBe(201);
    const status = await getJson(`${host.url}/v1/admin/tenants/${tenantId}`, {
      headers: adminHeaders(),
    });
    const tenant = await getJson(`${host.url}/v1/tenant`, {
      headers: {
        authorization: `Bearer ${applicationKey}`,
        [TENANT_HEADER]: tenantId,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      },
    });
    expect(tenant.status).toBe(200);
    // The envelope, and its Postgres schema version, is the same everywhere.
    expect((tenant.body as { tenant: unknown }).tenant).toEqual(
      (status.body as { envelope: unknown }).envelope,
    );
    expect(created.body).toEqual((status.body as { envelope: unknown }).envelope);

    const shutdown = await getJson(`${host.url}/v1/admin/host/shutdown`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(shutdown.status).toBe(200);
    await host.closed;
    expect(steps).toEqual(["worker", "infra"]);
    await expect(infra.database!`select 1`).rejects.toThrow();
  });
});
