import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createPostgresTenantStore } from "../../src/tenant/store-pg.js";
import { TenantUnavailableError } from "../../src/tenant/types.js";
import {
  bootstrapMaterial,
  configForRoot,
  createFakeOpenRuntime,
  silentLogger,
} from "./support.js";
import { testPool } from "../support/store.js";

it("does not quarantine a Tenant whose open failed outside it, and opens it on the next use", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-unavailable-"));
  let down = true;
  const openRuntime = createFakeOpenRuntime({
    hostRoot,
    failFor: (id) => (down ? new TenantUnavailableError(id) : undefined),
  });
  const store = createPostgresTenantStore({
    hostRoot,
    sql: testPool(),
    openRuntime,
    configFor: configForRoot(hostRoot),
  });
  const module = createTenantModule({ store, logger: silentLogger() });
  const id = newTenantId();
  const iso = new Date().toISOString();
  await store.create(
    { id, name: "t", createdAt: iso, updatedAt: iso, schemaVersion: 1 },
    bootstrapMaterial(),
  );
  await module.start();

  await expect(module.resolve(id)).rejects.toBeInstanceOf(TenantUnavailableError);
  await expect(module.worker(id)).rejects.toMatchObject({ status: 503 });
  expect((await module.list()).find((t) => t.id === id)?.state).toBe("open");

  down = false;
  expect((await module.resolve(id)).kind).toBe("open");
  await module.close();
  await rm(hostRoot, { recursive: true, force: true });
});
