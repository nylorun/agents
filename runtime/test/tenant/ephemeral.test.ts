/**
 * `startEphemeralRuntime` (`tenant/ephemeral.ts`): an in-process Host serving the one Tenant of
 * the Postgres database it is given, created there on first start through the Host's bootstrap.
 * It runs turns and leaves no session data under its Host root.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  newTenantId,
} from "@nylorun/core/compatibility";
import { Agent } from "@nylorun/core/define";
import { deriveTenantKey } from "@nylorun/admin";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { until } from "../host/execution-support.js";
import { fileDatabaseName, testDatabaseUrl } from "../support/database.js";
import { tenantTestDatabase, testPool } from "../support/store.js";

const roots: string[] = [];
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const bot = Agent({ id: "bot", name: "Bot" }).build();

/** Connections the Runtime's own pools hold on the test file's database. */
async function runtimeConnections(): Promise<number> {
  const sql = testPool();
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${fileDatabaseName()} AND application_name = 'nylorun-runtime'`;
  return row!.n;
}

it("runs a turn on a Tenant in its database, ends its own pool and removes its Host root on close", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-ephemeral-"));
  roots.push(hostRoot);
  // A URL: the Runtime opens its own pool on it.
  const runtime = await startEphemeralRuntime({
    hostRoot,
    baseline: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    model: { kind: "scripted", output: "hello from postgres" },
    database: testDatabaseUrl(fileDatabaseName()),
  });
  const headers = {
    authorization: `Bearer ${runtime.applicationKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  };
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${runtime.url}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  expect(
    (
      await call("/v1/agents/bot", "PUT", {
        requestId: "put-bot",
        manifest: bot.manifest,
        implementationVersion: "dev",
      })
    ).ok
  ).toBe(true);
  expect(
    (await call("/v1/sessions/s1", "PUT", { requestId: "s1", agentId: "bot", ownerUserId: "u" }))
      .ok
  ).toBe(true);
  expect(
    (
      await call("/v1/sessions/s1/commands", "POST", {
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "hi",
      })
    ).ok
  ).toBe(true);
  const items = await until(
    async () =>
      ((await (await call("/v1/sessions/s1/items")).json()) as { items: { type: string }[] })
        .items,
    (list) => list.some((item) => item.type === "turn.completed"),
    "turn.completed"
  );
  expect(JSON.stringify(items)).toContain("hello from postgres");

  // No Session Store file anywhere under the Host root.
  const files = readdirSync(hostRoot, { recursive: true }).map(String);
  expect(files.filter((file) => /sqlite|\.db$/.test(file))).toEqual([]);

  await runtime.close();
  expect(existsSync(hostRoot)).toBe(false);
  await until(runtimeConnections, (n) => n === 0, "the Runtime's pool to end");
  // The session is in the Tenant's database, which outlives the Runtime.
  const { store, envelope } = await openTenantDatabase({ sql: testPool(), create: { name: "unused" } });
  try {
    expect(envelope.id).toBe(runtime.tenantId);
    const session = await store.tx((t) => t.get<{ agentId: string }>("sessions", "s1"));
    expect(session).toMatchObject({ agentId: "bot" });
  } finally {
    await store.close();
  }
});

it("closes what it opened and removes its Host root when it fails to start", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-ephemeral-fail-"));
  roots.push(hostRoot);
  const database = await tenantTestDatabase();
  await expect(
    startEphemeralRuntime({
      hostRoot,
      // Refused when the Tenant is created, after the module has started opening it.
      tenantId: "not-a-tenant-id",
      model: { kind: "scripted", output: "unused" },
      database: database.url,
    })
  ).rejects.toThrow(/could not be opened/);
  expect(existsSync(hostRoot)).toBe(false);
  const [row] = await database.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${database.name} AND application_name = 'nylorun-runtime'`;
  expect(row!.n).toBe(0);
});

it("creates its Tenant once, as a Host does, and serves it again on the same database", async () => {
  const database = await tenantTestDatabase();
  const tenantId = newTenantId();
  const firstRoot = await mkdtemp(join(tmpdir(), "nylorun-ephemeral-"));
  // A pool: the caller ends it.
  const first = await startEphemeralRuntime({
    hostRoot: firstRoot,
    tenantId,
    name: "first",
    database: database.sql,
  });
  expect(first.tenantId).toBe(tenantId);
  await first.close();

  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-ephemeral-"));
  roots.push(hostRoot);
  const runtime = await startEphemeralRuntime({
    hostRoot,
    tenantId: newTenantId(),
    database: database.sql,
  });
  closers.push(runtime);
  // The database's Tenant, not a new one; this run's application key is added to it.
  expect(runtime.tenantId).toBe(tenantId);
  const status = (key: string) =>
    fetch(`${runtime.url}/v1/tenant`, {
      headers: { authorization: `Bearer ${key}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
    });
  const own = await status(runtime.applicationKey);
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ tenant: { id: tenantId, name: "first" } });
  // The first run's application key is still the Tenant's; no derived principal was registered.
  expect((await status(first.applicationKey)).status).toBe(200);
  expect((await status(deriveTenantKey(first.adminKey, tenantId, "project"))).status).toBe(404);
  // No Admin Tenant routes.
  const admin = await fetch(`${runtime.url}/v1/admin/tenants`, {
    headers: {
      authorization: `Bearer ${runtime.adminKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
  });
  expect(admin.status).toBe(404);
});
