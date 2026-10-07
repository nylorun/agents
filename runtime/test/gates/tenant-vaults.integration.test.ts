/**
 * The gates service's Tenant vault (`gates/tenant-vaults.ts`) on the test stack's Postgres:
 * the host model the Runtime stored is what the gate reads, a refreshed credential is written
 * back, the gate serves its database's one Tenant only, and it never migrates a database or
 * creates a vault key.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantVaults, GateRefusal } from "../../src/gates/tenant-vaults.js";
import type { PostgresClient } from "../../src/store/postgres/connect.js";
import { database } from "../../src/store/postgres/db.js";
import {
  readSchemaVersion,
  shippedMigrations,
  type Migration,
} from "../../src/store/postgres/migrate.js";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import type { SessionStore } from "../../src/store/types.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { createKekFile } from "../../src/vault/kek.js";
import { VaultService } from "../../src/vault/service.js";
import { STACK_ENABLED } from "../stack/endpoints.js";
import { emptyTestDatabase, tenantTestDatabase } from "../support/database.js";

describe.skipIf(!STACK_ENABLED)("the gates service's Tenant vault on Postgres", () => {
  const stores: SessionStore[] = [];
  const roots: string[] = [];

  async function tenant(
    migrations?: readonly Migration[],
  ): Promise<{ id: string; sql: PostgresClient; hostRoot: string }> {
    // A database never migrated, so `migrations` decides its version.
    const { sql } = await emptyTestDatabase();
    const id = newTenantId();
    const opened = await openTenantDatabase({
      sql,
      create: { tenantId: id, name: "gate" },
      ...(migrations ? { migrations } : {}),
    });
    stores.push(opened.store);
    const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-gates-"));
    roots.push(hostRoot);
    return { id, sql, hostRoot };
  }

  /** Stores the host model as the Runtime does: through its own vault, with the key file. */
  async function storeHostModel(sql: PostgresClient, hostRoot: string, key: string): Promise<void> {
    const opened = await openTenantDatabase({ sql, create: { name: "gate" } });
    stores.push(opened.store);
    const kek = createKekFile(tenantPaths(hostRoot).kek);
    await new VaultService({ store: opened.store, kek: () => kek }).putHostModel({
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
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("reads the host model the Runtime stored, and writes a refreshed credential back", async () => {
    const { id, sql, hostRoot } = await tenant();
    await storeHostModel(sql, hostRoot, "gate-pg-secret-1");
    // A call naming no Tenant gets the database's.
    const vault = await createTenantVaults({ sql, hostRoot }).open();
    expect(vault.tenantId).toBe(id);
    expect(vault.root).toBe(tenantPaths(hostRoot).home);
    expect(await vault.readHostModel()).toMatchObject({
      provider: "custom",
      model: "fixture",
      credential: { type: "api_key", key: "gate-pg-secret-1" },
    });
    await vault.writeHostCredential({ type: "api_key", key: "gate-pg-secret-2" });
    const again = await createTenantVaults({ sql, hostRoot }).open(id);
    expect((await again.readHostModel())?.credential).toEqual({
      type: "api_key",
      key: "gate-pg-secret-2",
    });
  });

  it("refuses a call naming another Tenant", async () => {
    const { sql, hostRoot } = await tenant();
    const vaults = createTenantVaults({ sql, hostRoot });
    for (const named of [newTenantId(), "../../etc"]) {
      const refused = await vaults.open(named).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(GateRefusal);
      expect((refused as GateRefusal).outcome).toMatchObject({
        code: "invalid_request",
        retryable: false,
      });
    }
  });

  it("refuses with an auth failure, and creates no key, when the vault key is missing", async () => {
    const { sql, hostRoot } = await tenant();
    await storeHostModel(sql, hostRoot, "gate-pg-secret-3");
    const elsewhere = await mkdtemp(join(tmpdir(), "nylorun-gates-empty-"));
    roots.push(elsewhere);
    const vault = await createTenantVaults({ sql, hostRoot: elsewhere }).open();
    const refused = await vault.readHostModel().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GateRefusal);
    expect((refused as GateRefusal).outcome).toMatchObject({ code: "auth", retryable: false });
    expect(existsSync(tenantPaths(elsewhere).kek)).toBe(false);
  });

  it("refuses a database without a Tenant, and one not yet migrated, without migrating it", async () => {
    const { sql, hostRoot } = await tenant(shippedMigrations().slice(0, -1));
    const before = await readSchemaVersion(database(sql));
    const stale = await createTenantVaults({ sql, hostRoot })
      .open()
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(GateRefusal);
    expect((stale as GateRefusal).outcome).toMatchObject({ code: "transient", retryable: true });
    expect(await readSchemaVersion(database(sql))).toBe(before);

    for (const empty of [await emptyTestDatabase(), await tenantTestDatabase()]) {
      const refused = await createTenantVaults({ sql: empty.sql, hostRoot })
        .open()
        .catch((error: unknown) => error);
      expect((refused as GateRefusal).outcome, empty.name).toMatchObject({
        code: "transient",
        retryable: true,
      });
    }
  });
});
