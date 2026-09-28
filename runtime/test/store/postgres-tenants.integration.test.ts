import { afterAll, afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { TenantConflictError } from "../../src/tenant/quarantine.js";
import type { BootstrapPrincipal } from "../../src/tenant/types.js";
import {
  createPostgresClient,
  type PostgresClient,
} from "../../src/store/postgres/connect.js";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  readSchemaVersion,
  type Migration,
} from "../../src/store/postgres/migrations/index.js";
import { tenantSchemaName } from "../../src/store/postgres/names.js";
import {
  createPostgresTenantCatalog,
  type PostgresTenantCatalog,
} from "../../src/store/postgres/tenants.js";
import type { SessionStore } from "../../src/store/types.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

const hex = (c: string) => c.repeat(64);

function envelope(id: string, name = "harness") {
  return {
    id,
    name,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    schemaVersion: 3,
  };
}

function bootstrap(fields: Partial<BootstrapPrincipal> = {}): BootstrapPrincipal {
  return {
    principalId: "pr_01k8z3aaaaaaaaaaaaaaaaaaaa",
    credentialHash: hex("a"),
    idempotencyKey: "idem-1",
    studioCredentialHash: hex("b"),
    ...fields,
  };
}

describe.skipIf(!STACK_ENABLED)("Postgres Tenant catalog", () => {
  let client: PostgresClient | undefined;
  const sql = () =>
    (client ??= createPostgresClient(stackEndpoints().postgres.url, { max: 10 }));
  const created = new Set<string>();
  const stores: SessionStore[] = [];
  const catalog = (migrations?: readonly Migration[]): PostgresTenantCatalog =>
    createPostgresTenantCatalog({
      sql: sql(),
      now: () => new Date("2030-01-02T00:00:00.000Z"),
      ...(migrations ? { migrations } : {}),
    });

  async function create(
    c = catalog(),
    principals: BootstrapPrincipal = bootstrap(),
  ): Promise<string> {
    const id = newTenantId();
    created.add(id);
    const result = await c.createTenant({ envelope: envelope(id), principals });
    expect(result.status).toBe("created");
    return id;
  }

  async function openStore(c: PostgresTenantCatalog, id: string): Promise<SessionStore> {
    const opened = await c.openTenant(id);
    if (opened.status !== "ok") throw new Error(`not ok: ${JSON.stringify(opened)}`);
    stores.push(opened.store);
    return opened.store;
  }

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    const c = catalog();
    for (const id of [...created]) {
      await c.deleteTenant(id);
      created.delete(id);
    }
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("creates a Tenant with its envelope and bootstrap principals in one schema", async () => {
    const c = catalog();
    const id = await create(c);
    expect(await c.readEnvelope(id)).toEqual({
      ...envelope(id),
      schemaVersion: POSTGRES_SCHEMA_VERSION,
    });
    expect(await readSchemaVersion(sql(), tenantSchemaName(id))).toBe(POSTGRES_SCHEMA_VERSION);
    const store = await openStore(c, id);
    await store.tx(async (t) => {
      expect(await t.principalById("pr_01k8z3aaaaaaaaaaaaaaaaaaaa")).toEqual({
        id: "pr_01k8z3aaaaaaaaaaaaaaaaaaaa",
        role: "application",
        tokenHash: hex("a"),
        idempotencyKey: "idem-1",
        createdAt: "2030-01-02T00:00:00.000Z",
      });
      expect(await t.principalById("studio")).toMatchObject({
        role: "application",
        tokenHash: hex("b"),
        idempotencyKey: null,
      });
      expect(await t.applicationTokenHashes()).toEqual([hex("a"), hex("b")]);
    });
    expect(await store.health()).toMatchObject({ ok: true });
  });

  it("creates without a Studio principal when no Studio hash is given", async () => {
    const c = catalog();
    const principals = bootstrap({ studioCredentialHash: undefined });
    const id = await create(c, principals);
    const store = await openStore(c, id);
    expect(await store.tx((t) => t.principalById("studio"))).toBeUndefined();
    expect(await c.bootstrapMatches(id, principals)).toBe(true);
    expect(await c.bootstrapMatches(id, bootstrap())).toBe(false);
  });

  it("lists Tenant schemas with their envelopes and ignores other schemas", async () => {
    const c = catalog();
    const one = await create(c);
    const two = await create(c);
    const client = sql();
    await client`CREATE SCHEMA IF NOT EXISTS tenant_not_an_id`;
    try {
      const listed = await c.listTenants();
      const mine = listed.filter((t) => created.has(t.id));
      expect(mine.map((t) => t.id)).toEqual([one, two].sort());
      expect(mine.every((t) => t.envelope?.name === "harness" && !t.quarantine)).toBe(true);
      expect(listed.some((t) => t.id === "not_an_id")).toBe(false);
    } finally {
      await client`DROP SCHEMA tenant_not_an_id`;
    }
  });

  it("makes create idempotent for the same bootstrap and refuses a different one", async () => {
    const c = catalog();
    const id = await create(c);
    const again = await c.createTenant({
      envelope: envelope(id, "renamed"),
      principals: bootstrap(),
    });
    expect(again).toEqual({
      status: "exists",
      envelope: { ...envelope(id), schemaVersion: POSTGRES_SCHEMA_VERSION },
    });
    for (const different of [
      bootstrap({ credentialHash: hex("c") }),
      bootstrap({ idempotencyKey: "idem-2" }),
      bootstrap({ studioCredentialHash: undefined }),
      bootstrap({ studioCredentialHash: hex("d") }),
      bootstrap({ principalId: "pr_01k8z3bbbbbbbbbbbbbbbbbbbb" }),
    ])
      await expect(
        c.createTenant({ envelope: envelope(id), principals: different }),
      ).rejects.toBeInstanceOf(TenantConflictError);
  });

  it("stores derived principals and compares them on a retried create", async () => {
    const c = catalog();
    const derived = [
      { id: "babai", credentialHash: hex("e") },
      { id: "smoke", credentialHash: hex("f") },
    ];
    const id = await create(c, bootstrap({ derivedPrincipals: derived }));
    const rows = await sql()`
      SELECT id, token_hash, idempotency_key FROM ${sql()(`${tenantSchemaName(id)}.principals`)}
      WHERE id IN ('babai', 'smoke') ORDER BY id`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { id: "babai", token_hash: hex("e"), idempotency_key: null },
      { id: "smoke", token_hash: hex("f"), idempotency_key: null },
    ]);
    await expect(
      c.createTenant({
        envelope: envelope(id),
        principals: bootstrap({ derivedPrincipals: derived }),
      }),
    ).resolves.toMatchObject({ status: "exists" });
    for (const different of [
      [{ id: "babai", credentialHash: hex("9") }],
      [{ id: "other", credentialHash: hex("e") }],
    ])
      await expect(
        c.createTenant({
          envelope: envelope(id),
          principals: bootstrap({ derivedPrincipals: different }),
        }),
      ).rejects.toBeInstanceOf(TenantConflictError);
  });

  it("creates a Tenant once under concurrent creates", async () => {
    const c = catalog();
    const id = newTenantId();
    created.add(id);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        c.createTenant({ envelope: envelope(id), principals: bootstrap() }),
      ),
    );
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.status === "exists")).toHaveLength(4);
  });

  it("leaves nothing behind when create fails", async () => {
    const c = catalog();
    const id = newTenantId();
    created.add(id);
    // The Studio principal reuses the application token hash: unique violation.
    await expect(
      c.createTenant({
        envelope: envelope(id),
        principals: bootstrap({ studioCredentialHash: hex("a") }),
      }),
    ).rejects.toThrow();
    expect(await readSchemaVersion(sql(), tenantSchemaName(id))).toBeUndefined();
    expect((await c.listTenants()).some((t) => t.id === id)).toBe(false);
    expect(await c.openTenant(id)).toEqual({ status: "not-found" });
  });

  it("does not find unknown or invalid Tenant ids", async () => {
    const c = catalog();
    expect(await c.openTenant(newTenantId())).toEqual({ status: "not-found" });
    expect(await c.openTenant("tn_bad")).toEqual({ status: "not-found" });
    expect(await c.bootstrapMatches(newTenantId(), bootstrap())).toBe(false);
    await expect(
      c.createTenant({ envelope: envelope("tn_bad"), principals: bootstrap() }),
    ).rejects.toThrow("Invalid tenant id");
  });

  it("quarantines a Tenant whose schema is newer than the Runtime, and only that Tenant", async () => {
    const c = catalog();
    const newer = await create(c);
    const other = await create(c);
    const client = sql();
    await client`INSERT INTO ${client(`${tenantSchemaName(newer)}.schema_version`)} (version, name) VALUES (${POSTGRES_SCHEMA_VERSION + 1}, 'future')`;
    const opened = await c.openTenant(newer);
    expect(opened).toMatchObject({
      status: "quarantined",
      reason: { code: "schema-too-new" },
    });
    await expect(c.migrateTenant(newer)).rejects.toMatchObject({ code: "schema-too-new" });
    expect(await readSchemaVersion(client, tenantSchemaName(newer))).toBe(POSTGRES_SCHEMA_VERSION + 1);
    expect((await c.openTenant(other)).status).toBe("ok");
    const listed = (await c.listTenants()).find((t) => t.id === newer);
    expect(listed?.envelope?.id).toBe(newer);
  });

  it("migrates an older schema forward on open", async () => {
    const id = await create(catalog());
    const v2: Migration = {
      version: MIGRATIONS.length + 1,
      name: "add_notes",
      up: (s) => `CREATE TABLE ${s}.notes (id text PRIMARY KEY);`,
    };
    const next = catalog([...MIGRATIONS, v2]);
    const opened = await next.openTenant(id);
    expect(opened).toMatchObject({
      status: "ok",
      migrated: { from: MIGRATIONS.length, to: v2.version },
      envelope: { schemaVersion: v2.version },
    });
    if (opened.status === "ok") {
      stores.push(opened.store);
      expect(await opened.store.health()).toMatchObject({ ok: true, schemaVersion: v2.version });
    }
    const client = sql();
    const rows = await client`SELECT version, name FROM ${client(`${tenantSchemaName(id)}.schema_version`)} ORDER BY version`;
    expect(rows.map((r) => r.name)).toEqual([...MIGRATIONS.map((m) => m.name), "add_notes"]);
    // Opened again: nothing to do.
    expect(await next.openTenant(id)).toMatchObject({
      migrated: { from: v2.version, to: v2.version },
    });
    // The old Runtime now sees a newer schema.
    expect(await catalog().openTenant(id)).toMatchObject({
      status: "quarantined",
      reason: { code: "schema-too-new" },
    });
  });

  it("quarantines a Tenant whose migration fails and rolls the migration back", async () => {
    const id = await create(catalog());
    const broken: Migration = {
      version: MIGRATIONS.length + 1,
      name: "broken",
      up: (s) => `CREATE TABLE ${s}.half (id text); SELECT 1/0;`,
    };
    const opened = await catalog([...MIGRATIONS, broken]).openTenant(id);
    expect(opened).toMatchObject({
      status: "quarantined",
      reason: { code: "migration-failed" },
    });
    expect(await readSchemaVersion(sql(), tenantSchemaName(id))).toBe(MIGRATIONS.length);
    const client = sql();
    const [row] = await client`SELECT to_regclass(${`"${tenantSchemaName(id)}".half`}) AS half`;
    expect(row!.half).toBeNull();
    expect((await catalog().openTenant(id)).status).toBe("ok");
  });

  it("quarantines a Tenant whose envelope is missing", async () => {
    const c = catalog();
    const id = await create(c);
    const client = sql();
    await client`DELETE FROM ${client(`${tenantSchemaName(id)}.tenant`)}`;
    expect(await c.openTenant(id)).toMatchObject({
      status: "quarantined",
      reason: { code: "envelope-invalid" },
    });
    const listed = (await c.listTenants()).find((t) => t.id === id);
    expect(listed).toMatchObject({ envelope: null, quarantine: { code: "envelope-invalid" } });
  });

  it("deletes a Tenant and everything in its schema", async () => {
    const c = catalog();
    const id = await create(c);
    const store = await openStore(c, id);
    await store.tx((t) => t.put("sessions", "s1", { id: "s1", agentId: "a", status: "idle", activeTurnId: null }));
    await store.close();
    expect(await c.deleteTenant(id)).toBe(true);
    expect(await c.deleteTenant(id)).toBe(false);
    expect(await readSchemaVersion(sql(), tenantSchemaName(id))).toBeUndefined();
    expect((await c.listTenants()).some((t) => t.id === id)).toBe(false);
    expect(await c.openTenant(id)).toEqual({ status: "not-found" });
    // The id can be created again from scratch.
    const again = await c.createTenant({ envelope: envelope(id), principals: bootstrap() });
    expect(again.status).toBe("created");
  });
});
