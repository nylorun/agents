/**
 * The gates service's Tenant vaults (`gates/tenant-vaults.ts`) on the test stack's Postgres:
 * the host model the Runtime stored is what the gate reads, a refreshed credential is written
 * back, and the gate never migrates a schema or creates a vault key.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantVaults, GateRefusal } from "../../src/gates/tenant-vaults.js";
import {
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import {
  MIGRATIONS,
  readSchemaVersion,
  type Migration,
} from "../../src/store/postgres/migrations/index.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import { createPostgresTenantCatalog } from "../../src/store/postgres/tenants.js";
import type { SessionStore } from "../../src/store/types.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { createKekFile } from "../../src/vault/kek.js";
import { VaultService } from "../../src/vault/service.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

describe.skipIf(!STACK_ENABLED)("gates Tenant vaults on Postgres", () => {
  let client: PostgresClient | undefined;
  const sql = () =>
    (client ??= createPostgresClient(stackEndpoints().postgres.url, { max: 10 }));
  const catalog = (migrations?: readonly Migration[]) =>
    createPostgresTenantCatalog({ sql: sql(), ...(migrations ? { migrations } : {}) });
  const created: string[] = [];
  const stores: SessionStore[] = [];
  const roots: string[] = [];

  async function tenant(migrations?: readonly Migration[]): Promise<{ id: string; hostRoot: string }> {
    const id = newTenantId();
    created.push(id);
    const now = new Date().toISOString();
    const result = await catalog(migrations).createTenant({
      envelope: { id, name: "gate", createdAt: now, updatedAt: now, schemaVersion: 1 },
      principals: {
        principalId: "pr_01k8z3aaaaaaaaaaaaaaaaaaaa",
        credentialHash: "a".repeat(64),
        idempotencyKey: "idem-1",
        studioCredentialHash: "b".repeat(64),
      },
    });
    expect(result.status).toBe("created");
    const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-gates-"));
    roots.push(hostRoot);
    return { id, hostRoot };
  }

  /** Stores the host model as the Runtime does: through its own vault, with the key file. */
  async function storeHostModel(id: string, hostRoot: string, key: string): Promise<void> {
    const opened = await catalog().openTenant(id);
    if (opened.status !== "ok") throw new Error(JSON.stringify(opened));
    stores.push(opened.store);
    const kek = createKekFile(tenantPaths(hostRoot, id).kek);
    await new VaultService({ store: opened.store, kek: () => kek, fetch }).putHostModel({
      requestId: "host-1",
      idempotencyKey: "host-model",
      provider: "custom",
      model: "fixture",
      baseUrl: "https://models.example.test/v1",
      auth: { type: "api_key", key },
    });
  }

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    for (const id of created.splice(0)) await catalog().deleteTenant(id);
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("reads the host model the Runtime stored, and writes a refreshed credential back", async () => {
    const { id, hostRoot } = await tenant();
    await storeHostModel(id, hostRoot, "gate-pg-secret-1");
    const vault = await createTenantVaults({ sql: sql(), hostRoot }).open(id);
    expect(vault.root).toBe(tenantPaths(hostRoot, id).home);
    expect(await vault.readHostModel()).toMatchObject({
      provider: "custom",
      model: "fixture",
      credential: { type: "api_key", key: "gate-pg-secret-1" },
    });
    await vault.writeHostCredential({ type: "api_key", key: "gate-pg-secret-2" });
    const again = await createTenantVaults({ sql: sql(), hostRoot }).open(id);
    expect((await again.readHostModel())?.credential).toEqual({
      type: "api_key",
      key: "gate-pg-secret-2",
    });
  });

  it("refuses with an auth failure, and creates no key, when the vault key is missing", async () => {
    const { id, hostRoot } = await tenant();
    await storeHostModel(id, hostRoot, "gate-pg-secret-3");
    const elsewhere = await mkdtemp(join(tmpdir(), "nylorun-gates-empty-"));
    roots.push(elsewhere);
    const vault = await createTenantVaults({ sql: sql(), hostRoot: elsewhere }).open(id);
    const refused = await vault.readHostModel().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GateRefusal);
    expect((refused as GateRefusal).outcome).toMatchObject({ code: "auth", retryable: false });
    expect(existsSync(tenantPaths(elsewhere, id).kek)).toBe(false);
  });

  it("refuses a Tenant that doesn't exist, and one not yet migrated, without migrating it", async () => {
    const vaults = (hostRoot: string) => createTenantVaults({ sql: sql(), hostRoot });
    const { id, hostRoot } = await tenant(MIGRATIONS.slice(0, -1));
    const before = await readSchemaVersion(sql(), tenantSchemaName(id));
    const stale = await vaults(hostRoot).open(id).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(GateRefusal);
    expect((stale as GateRefusal).outcome).toMatchObject({ code: "transient", retryable: true });
    expect(await readSchemaVersion(sql(), tenantSchemaName(id))).toBe(before);

    const missing = await vaults(hostRoot).open(newTenantId()).catch((error: unknown) => error);
    expect((missing as GateRefusal).outcome).toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });
});
