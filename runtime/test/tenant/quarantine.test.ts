import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createFsTenantStore } from "../../src/tenant/store-fs.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import {
  bootstrapMaterial,
  configForRoot,
  createFakeOpenRuntime,
  silentLogger,
} from "./support.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it("a leftover .runtime-lock file does not quarantine the Tenant", async () => {
  // Ownership of each session (not a Tenant lock file) keeps processes apart.
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-lock-"));
  roots.push(hostRoot);
  const openRuntime = createFakeOpenRuntime({ hostRoot });
  const configFor = configForRoot(hostRoot);
  const store = createFsTenantStore({ hostRoot, openRuntime, configFor });
  const module = createTenantModule({
    hostRoot,
    store,
    openRuntime,
    configFor,
    logger: silentLogger(),
  });
  const id = newTenantId();
  const iso = new Date().toISOString();
  await store.create(
    { id, name: "t", createdAt: iso, updatedAt: iso, schemaVersion: 1 },
    bootstrapMaterial(),
  );
  writeFileSync(join(tenantPaths(hostRoot, id).root, ".runtime-lock"), String(process.pid));
  await module.start();
  const resolution = await module.resolve(id);
  expect(resolution.kind).toBe("open");
});

it("every quarantine code carries a CLI repair string", async () => {
  const { repairFor } = await import("../../src/tenant/quarantine.js");
  const codes = [
    "kek-missing",
    "corrupt",
    "schema-too-new",
    "migration-failed",
    "envelope-invalid",
    "open-timeout",
    "open-failed",
  ] as const;
  for (const code of codes) {
    const repair = repairFor(code, {
      tenantId: "tn_test",
      migrationPath: "/tmp/mig",
    });
    expect(repair.length).toBeGreaterThan(0);
    expect(repair).toMatch(/nylorun|restore/);
  }
});
