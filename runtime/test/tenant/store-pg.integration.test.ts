/**
 * The Tenant module on the Postgres Tenant store (architecture §8.2), against the test
 * stack's Postgres and the real Tenant Runtime: create, list, open on demand, quarantine and
 * delete.
 */
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  type Migration,
} from "../../src/store/postgres/migrations/index.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { createTenantModule } from "../../src/tenant/module.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { TenantConflictError } from "../../src/tenant/quarantine.js";
import { openTenantRuntime } from "../../src/tenant/runtime.js";
import { createPostgresTenantStore } from "../../src/tenant/store-pg.js";
import { TenantNotFoundError, type TenantConfig } from "../../src/tenant/types.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import { bootstrapMaterial, configForRoot, silentLogger } from "./support.js";

let pool: PostgresClient | undefined;
const sql = () =>
  (pool ??= createPostgresClient(stackEndpoints().postgres.url, { max: 10 }));

const roots: string[] = [];
const schemas: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const schema of schemas.splice(0))
    await sql()`DROP SCHEMA IF EXISTS ${sql()(schema)} CASCADE`;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await pool?.end({ timeout: 5 });
});

async function setup(options: { migrations?: readonly Migration[] } = {}) {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-pg-module-"));
  roots.push(hostRoot);
  const configFor = (id: string): TenantConfig => ({
    ...configForRoot(hostRoot)(id),
    model: { kind: "scripted", output: "ok" },
  });
  const streams = new MemoryStreams();
  const opened: string[] = [];
  const deleted: string[] = [];
  const store = createPostgresTenantStore({
    hostRoot,
    sql: sql(),
    configFor,
    ...(options.migrations ? { migrations: options.migrations } : {}),
    openRuntime: (config, handles) => {
      opened.push(config.tenantId);
      return openTenantRuntime(config, { createKekIfMissing: true, streams, ...handles });
    },
  });
  const module = createTenantModule({
    store,
    logger: silentLogger(),
    onDeleted: async (id) => void deleted.push(id),
  });
  closers.push(() => module.close());
  await module.start();
  const create = async (name = "t", boot = bootstrapMaterial()) => {
    const tenantId = newTenantId();
    schemas.push(tenantSchemaName(tenantId));
    const result = await module.create({ tenantId, name, ...boot });
    return { tenantId, boot, result };
  };
  return { hostRoot, store, module, create, opened, deleted };
}

describe.skipIf(!STACK_ENABLED)("Tenant module on Postgres", () => {
  it("creates a schema and the Tenant directory, and retries idempotently or conflicts", async () => {
    const { module, create, hostRoot } = await setup();
    const { tenantId, boot, result } = await create("alpha");
    expect(result.created).toBe(true);
    expect(result.envelope).toMatchObject({
      id: tenantId,
      name: "alpha",
      schemaVersion: POSTGRES_SCHEMA_VERSION,
    });
    const paths = tenantPaths(hostRoot, tenantId);
    for (const dir of [paths.home, paths.tmp, paths.sandboxes, paths.pluginData, paths.logs])
      expect(existsSync(dir)).toBe(true);

    const again = await module.create({ tenantId, name: "alpha", ...boot });
    expect(again).toEqual({ envelope: result.envelope, created: false });
    await expect(
      module.create({ tenantId, name: "alpha", ...bootstrapMaterial({ credentialHash: "cd".repeat(32) }) }),
    ).rejects.toBeInstanceOf(TenantConflictError);
    // A conflicting create leaves the existing Tenant and its directory alone.
    expect(existsSync(paths.pluginData)).toBe(true);
    expect((await module.resolve(tenantId)).kind).toBe("open");
  });

  it("lists without opening and opens each Tenant once on first use", async () => {
    const first = await setup();
    const { tenantId } = await first.create("listed");
    await first.module.close();

    // A fresh Host: nothing opens at start or list.
    const host = await setup();
    const listed = await host.module.list();
    expect(listed.find((t) => t.id === tenantId)).toMatchObject({
      state: "open",
      name: "listed",
      envelope: { schemaVersion: POSTGRES_SCHEMA_VERSION },
    });
    expect(host.opened).toEqual([]);

    const [worker, resolution, status] = await Promise.all([
      host.module.worker(tenantId),
      host.module.resolve(tenantId),
      host.module.status(tenantId),
    ]);
    expect(host.opened).toEqual([tenantId]);
    expect(resolution.kind).toBe("open");
    if (resolution.kind === "open") {
      expect(worker).toBe(resolution.handle.worker);
      expect(status?.envelope).toEqual(resolution.handle.envelope);
    }
    expect(await host.module.worker(newTenantId())).toBeUndefined();
    expect((await host.module.resolve(newTenantId())).kind).toBe("not-found");
  });

  it("migrates an older schema forward on open and reports the new version everywhere", async () => {
    const v1 = await setup({ migrations: MIGRATIONS });
    const { tenantId } = await v1.create("old");
    await v1.module.close();

    const next: Migration = {
      version: MIGRATIONS.length + 1,
      name: "test_next",
      up: (s) => `CREATE TABLE ${s}.test_next (id text PRIMARY KEY);`,
    };
    const v2 = await setup({ migrations: [...MIGRATIONS, next] });
    const resolution = await v2.module.resolve(tenantId);
    expect(resolution.kind).toBe("open");
    if (resolution.kind !== "open") return;
    expect(resolution.handle.envelope.schemaVersion).toBe(next.version);
    expect((await v2.module.status(tenantId))?.envelope?.schemaVersion).toBe(next.version);
    expect(
      (await v2.module.list()).find((t) => t.id === tenantId)?.envelope?.schemaVersion,
    ).toBe(next.version);
  });

  it("quarantines a schema newer than the Runtime, one without an envelope, and ciphertext without a key", async () => {
    const { module, create } = await setup();
    const tooNew = await create("new");
    const empty = newTenantId();
    const kekless = await create("kekless");
    await module.close();

    const q = sql();
    const tooNewSchema = tenantSchemaName(tooNew.tenantId);
    await q`INSERT INTO ${q(`${tooNewSchema}.schema_version`)} (version, name) VALUES (99, 'future')`;
    schemas.push(tenantSchemaName(empty));
    await q`CREATE SCHEMA ${q(tenantSchemaName(empty))}`;
    const vault = tenantSchemaName(kekless.tenantId);
    await q`INSERT INTO ${q(`${vault}.vaults`)} (id, name, owner_user_id, created_at) VALUES ('v1', 'v', 'u', 'x')`;
    await q`
      INSERT INTO ${q(`${vault}.vault_credentials`)}
        (id, vault_id, name, type, binding_json, created_at, kek_id, nonce, ciphertext, wrapped_dek)
      VALUES ('c1', 'v1', 'c', 'bearer', '{}', 'x', 'k', '\\x00', '\\x00', '\\x00')`;

    const host = await setup();
    const tooNewResolution = await host.module.resolve(tooNew.tenantId);
    expect(tooNewResolution).toMatchObject({
      kind: "quarantined",
      quarantine: { code: "schema-too-new" },
    });
    if (tooNewResolution.kind === "quarantined")
      expect(tooNewResolution.quarantine.repair).toContain(tooNewSchema);
    expect(host.opened).toEqual([]);

    const emptyStatus = await host.module.status(empty);
    expect(emptyStatus).toMatchObject({
      state: "quarantined",
      name: null,
      envelope: null,
      quarantine: { code: "envelope-invalid" },
    });
    // This Host root has no vault key for `kekless`, whose schema holds ciphertext.
    const kekStatus = await host.module.status(kekless.tenantId);
    expect(kekStatus?.quarantine?.code).toBe("kek-missing");
    expect(kekStatus?.quarantine?.repair).toMatch(/restore vault-kek under the Tenant directory/);
    expect(await host.module.worker(tooNew.tenantId)).toBeUndefined();

    const listed = await host.module.list();
    expect(listed.find((t) => t.id === tooNew.tenantId)?.state).toBe("quarantined");
    expect(listed.find((t) => t.id === empty)?.state).toBe("quarantined");
  });

  it("deletes a Tenant: schema, directory and outside state, after the activeWork rule", async () => {
    const { module, create, hostRoot, deleted } = await setup();
    const { tenantId } = await create("gone");
    const resolution = await module.resolve(tenantId);
    expect(resolution.kind).toBe("open");
    // A key file shows the directory goes with the schema.
    writeFileSync(join(tenantPaths(hostRoot, tenantId).root, "marker"), "x");

    await module.delete(tenantId, "refuse");
    expect(deleted).toEqual([tenantId]);
    const q = sql();
    const [row] = await q`SELECT to_regnamespace(${tenantSchemaName(tenantId)}) AS ns`;
    expect(row!.ns).toBeNull();
    expect(existsSync(tenantPaths(hostRoot, tenantId).root)).toBe(false);
    expect((await module.resolve(tenantId)).kind).toBe("not-found");
    expect((await module.list()).some((t) => t.id === tenantId)).toBe(false);
    await expect(module.delete(tenantId, "refuse")).rejects.toBeInstanceOf(TenantNotFoundError);
  });
});
