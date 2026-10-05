/**
 * The Host composed the way `host/main.ts` composes it, against the test stack: the
 * infrastructure clients from `createInfra`, the Host execution, and the Host's Tenant in a
 * Postgres database of its own. `/ready` follows the Tenant and the infrastructure checks,
 * the Host creates and serves its Tenant, and shutdown ends the infrastructure clients.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveStudioToken } from "@nylorun/admin";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { AdminStatusSchema } from "@nylorun/core/contracts";
import { MemoryExecution } from "../../src/execution/memory.js";
import { createHost } from "../../src/host/create-host.js";
import { createHostExecution } from "../../src/host/execution.js";
import { createHostLogger } from "../../src/host/logger.js";
import { parseStackConfig } from "../../src/host/stack-config.js";
import { createInfra } from "../../src/infra/index.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { createTenantModule } from "../../src/tenant/module.js";
import { hostPrincipals } from "../../src/tenant/principals.js";
import { openTenantRuntime } from "../../src/tenant/runtime.js";
import { createPostgresTenantOpener } from "../../src/tenant/store-pg.js";
import type { TenantConfig } from "../../src/tenant/types.js";
import { configForRoot } from "../tenant/support.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import { tenantTestDatabase } from "../support/database.js";
import { ADMIN_KEY, adminHeaders, freePort, getJson } from "./support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

function stack(databaseUrl: string, overrides: Record<string, string> = {}) {
  const endpoints = stackEndpoints();
  return parseStackConfig(
    {
      NYLORUN_DATABASE_URL: databaseUrl,
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
  const database = await tenantTestDatabase();
  const infra = createInfra(stack(database.url, options.overrides));
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
  const base = createTenantModule({
    open: createPostgresTenantOpener({
      hostRoot,
      sql: infra.database!,
      create: { name: "pg", principals: hostPrincipals({ adminKey: ADMIN_KEY }) },
      configFor,
      openRuntime: (config, opened) =>
        openTenantRuntime(config, {
          execution: hostExecution.tenantExecution,
          streams,
          createKekIfMissing: true,
          ...opened,
        }),
    }),
    logger,
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
  it("/ready is 503 until the Tenant is open, then 200 with every infrastructure check", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { host, listening } = await startHost({ gate });
    const url = await waitForUrl(host);
    const before = await getJson(`${url}/ready`);
    expect(before.status).toBe(503);
    expect(before.body).toMatchObject({
      status: "not_ready",
      checks: { listener: true, tenant: false, postgres: true, restate: true, s2: true },
    });
    open();
    await listening;
    const after = await getJson(`${url}/ready`);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      status: "ready",
      checks: { listener: true, tenant: true, postgres: true, restate: true, s2: true },
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

  it("creates its Tenant in its database and serves it, and admin shutdown ends the infrastructure", async () => {
    const { host, listening, infra, steps } = await startHost();
    await listening;
    const status = AdminStatusSchema.parse(
      (await getJson(`${host.url}/v1/admin/status`, { headers: adminHeaders() })).body,
    );
    expect(status.tenant).toMatchObject({ name: "pg", state: "open" });
    const tenantId = status.tenant.id!;
    const tenant = await getJson(`${host.url}/v1/tenant`, {
      headers: {
        authorization: `Bearer ${deriveStudioToken(ADMIN_KEY)}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      },
    });
    expect(tenant.status).toBe(200);
    // The envelope, and its Postgres schema version, is the same everywhere.
    expect((tenant.body as { tenant: unknown }).tenant).toEqual(status.tenant.envelope);

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
