import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
const children: { kill(): boolean }[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it("lock held by a live PID quarantines as locked with path and pid", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-lock-"));
  roots.push(hostRoot);
  const openRuntime = createFakeOpenRuntime({ hostRoot, claimLock: true });
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
  const boot = bootstrapMaterial();
  // Create on disk without opening through the module.
  const iso = new Date().toISOString();
  await store.create(
    {
      id,
      name: "locked",
      createdAt: iso,
      updatedAt: iso,
      schemaVersion: 1,
    },
    boot,
  );

  const paths = tenantPaths(hostRoot, id);
  const holder = spawn("sleep", ["120"], { stdio: "ignore", detached: true });
  children.push(holder);
  if (holder.pid === undefined) throw new Error("failed to spawn lock holder");
  writeFileSync(paths.lock, String(holder.pid));

  await module.start();
  const resolution = await module.resolve(id);
  expect(resolution.kind).toBe("quarantined");
  if (resolution.kind !== "quarantined") return;
  expect(resolution.quarantine.code).toBe("locked");
  expect(resolution.quarantine.lockPid).toBe(holder.pid);
  expect(resolution.quarantine.lockPath).toBe(paths.lock);
  expect(resolution.quarantine.repair).toMatch(/nylorun tenant status/);
});

it("every quarantine code carries a CLI repair string", async () => {
  const { repairFor } = await import("../../src/tenant/quarantine.js");
  const codes = [
    "locked",
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
      lockPath: "/tmp/lock",
      lockPid: 1,
      migrationPath: "/tmp/mig",
    });
    expect(repair.length).toBeGreaterThan(0);
    expect(repair).toMatch(/nylorun|restore/);
  }
});
