import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { migrateTenantWithSnapshot } from "../../src/tenant/migration.js";
import { createFsTenantStore } from "../../src/tenant/store-fs.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { writeEnvelopeFile } from "../../src/tenant/envelope.js";
import { QuarantineError } from "../../src/tenant/quarantine.js";
import {
  TENANT_SCHEMA_VERSION,
  schemaVersionAt,
  withTenantDatabase,
} from "../../src/tenant/schema.js";
import { createSqliteSessionStore } from "../../src/store/sqlite.js";
import { createV3Database } from "../support/sqlite-v3.js";
import {
  bootstrapMaterial,
  configForRoot,
  createFakeOpenRuntime,
} from "./support.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it("snapshots database, envelope and KEK before migrating", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-mig-"));
  roots.push(hostRoot);
  const id = newTenantId();
  const openRuntime = createFakeOpenRuntime({ hostRoot });
  const configFor = configForRoot(hostRoot);
  const store = createFsTenantStore({ hostRoot, openRuntime, configFor });
  const iso = new Date().toISOString();
  await store.create(
    { id, name: "m", createdAt: iso, updatedAt: iso, schemaVersion: 0 },
    bootstrapMaterial(),
  );
  const paths = tenantPaths(hostRoot, id);
  // Downgrade schema so migration runs.
  withTenantDatabase(paths.database, (db) => db.exec("PRAGMA user_version = 0"));
  writeEnvelopeFile(paths.envelope, {
    id,
    name: "m",
    createdAt: iso,
    updatedAt: iso,
    schemaVersion: 0,
  });
  // Place a KEK file so the snapshot includes it.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(paths.kek, "test-kek-bytes");

  const updated = migrateTenantWithSnapshot(
    paths,
    {
      id,
      name: "m",
      createdAt: iso,
      updatedAt: iso,
      schemaVersion: 0,
    },
    {
      schemaVersionOf: (d) =>
        (d.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      migrateTenantDatabase: (d) => {
        d.exec("PRAGMA user_version = 1");
        return { from: 0, to: 1 };
      },
      targetVersion: 1,
    },
  );
  expect(updated.schemaVersion).toBe(1);
  expect(existsSync(paths.migration)).toBe(true);
  const { readdirSync } = await import("node:fs");
  const snaps = readdirSync(paths.migration);
  expect(snaps.length).toBeGreaterThanOrEqual(1);
  const snap = join(paths.migration, snaps[0]!);
  expect(existsSync(join(snap, "tenant.sqlite"))).toBe(true);
  expect(existsSync(join(snap, "tenant.json"))).toBe(true);
  expect(existsSync(join(snap, "vault-kek"))).toBe(true);
});

it("schema-too-new never mutates and quarantines", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-new-"));
  roots.push(hostRoot);
  const id = newTenantId();
  const openRuntime = createFakeOpenRuntime({ hostRoot });
  const configFor = configForRoot(hostRoot);
  const store = createFsTenantStore({
    hostRoot,
    openRuntime,
    configFor,
    migration: {
      schemaVersionOf: () => 99,
      targetVersion: 1,
    },
  });
  const iso = new Date().toISOString();
  await store.create(
    { id, name: "new", createdAt: iso, updatedAt: iso, schemaVersion: 99 },
    bootstrapMaterial(),
  );
  await expect(store.open(id)).rejects.toBeInstanceOf(QuarantineError);
  await expect(store.open(id)).rejects.toMatchObject({ code: "schema-too-new" });
});

it("failed migration restores the snapshot and quarantines", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-migfail-"));
  roots.push(hostRoot);
  const id = newTenantId();
  const openRuntime = createFakeOpenRuntime({ hostRoot });
  const configFor = configForRoot(hostRoot);
  const store = createFsTenantStore({ hostRoot, openRuntime, configFor });
  const iso = new Date().toISOString();
  await store.create(
    { id, name: "m", createdAt: iso, updatedAt: iso, schemaVersion: 0 },
    bootstrapMaterial(),
  );
  const paths = tenantPaths(hostRoot, id);
  withTenantDatabase(paths.database, (db) => db.exec("PRAGMA user_version = 0"));
  writeEnvelopeFile(paths.envelope, {
    id,
    name: "m",
    createdAt: iso,
    updatedAt: iso,
    schemaVersion: 0,
  });
  const before = readFileSync(paths.database);

  expect(() =>
    migrateTenantWithSnapshot(
      paths,
      {
        id,
        name: "m",
        createdAt: iso,
        updatedAt: iso,
        schemaVersion: 0,
      },
      {
        schemaVersionOf: () => 0,
        migrateTenantDatabase: () => {
          throw new Error("migrate blew up");
        },
        targetVersion: 1,
      },
    ),
  ).toThrow(QuarantineError);

  expect(readFileSync(paths.database)).toEqual(before);
  const envelope = JSON.parse(readFileSync(paths.envelope, "utf8")) as {
    schemaVersion: number;
  };
  expect(envelope.schemaVersion).toBe(0);
});

it("migrates a v3 Tenant to the current schema with the default migration", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-mig-v3-"));
  roots.push(hostRoot);
  const id = newTenantId();
  const paths = tenantPaths(hostRoot, id);
  mkdirSync(paths.root, { recursive: true });
  createV3Database(paths.database);
  const iso = new Date().toISOString();
  const envelope = { id, name: "v3", createdAt: iso, updatedAt: iso, schemaVersion: 3 };
  writeEnvelopeFile(paths.envelope, envelope);

  const updated = migrateTenantWithSnapshot(paths, envelope);
  expect(updated.schemaVersion).toBe(TENANT_SCHEMA_VERSION);
  expect(schemaVersionAt(paths.database)).toBe(TENANT_SCHEMA_VERSION);
  const store = createSqliteSessionStore({ path: paths.database, tenantId: id });
  expect((await store.readEvents("s1")).events.map((e) => e.type)).toEqual(["a", "c"]);
  await store.close();
});
