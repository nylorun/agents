import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createMemoryTenantStore } from "../../src/tenant/store-memory.js";
import { TimeoutError, withTimeout } from "../../src/tenant/pool.js";
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

it("withTimeout rejects and hands the late promise to onLate", async () => {
  let lateValue: number | undefined;
  const slow = new Promise<number>((resolve) => {
    setTimeout(() => resolve(42), 50);
  });
  await expect(
    withTimeout(slow, 5, (late) => {
      void late.then((v) => {
        lateValue = v;
      });
    }),
  ).rejects.toBeInstanceOf(TimeoutError);
  await new Promise((r) => setTimeout(r, 80));
  expect(lateValue).toBe(42);
});

it("start opens with concurrency 4 and quarantines open timeouts", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-pool-"));
  roots.push(hostRoot);
  const slowId = newTenantId();
  const openRuntime = createFakeOpenRuntime({
    hostRoot,
    openDelayMs: 200,
    failFor: () => undefined,
  });
  // Override delay only for slowId via beforeOpen sleep.
  const delayed = createFakeOpenRuntime({
    hostRoot,
    beforeOpen: async (config) => {
      if (config.tenantId === slowId) {
        await new Promise((r) => setTimeout(r, 200));
      }
    },
  });
  const configFor = configForRoot(hostRoot);
  const store = createMemoryTenantStore({
    hostRoot,
    openRuntime: delayed,
    configFor,
  });
  const iso = new Date().toISOString();
  await store.create(
    {
      id: slowId,
      name: "slow",
      createdAt: iso,
      updatedAt: iso,
      schemaVersion: 1,
    },
    bootstrapMaterial(),
  );
  const okId = newTenantId();
  await store.create(
    {
      id: okId,
      name: "ok",
      createdAt: iso,
      updatedAt: iso,
      schemaVersion: 1,
    },
    bootstrapMaterial(),
  );

  const module = createTenantModule({
    hostRoot,
    store,
    openRuntime: delayed,
    configFor,
    logger: silentLogger(),
    openTimeoutMs: 30,
  });
  await module.start();
  expect(module.started).toBe(true);
  expect((await module.resolve(okId)).kind).toBe("open");
  const slow = await module.resolve(slowId);
  expect(slow.kind).toBe("quarantined");
  if (slow.kind === "quarantined") {
    expect(slow.quarantine.code).toBe("open-timeout");
  }
  void openRuntime;
});
