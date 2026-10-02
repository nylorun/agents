import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createPostgresTenantStore } from "../../src/tenant/store-pg.js";
import type { TenantStore } from "../../src/tenant/types.js";
import { TenantConflictError } from "../../src/tenant/quarantine.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import { existsSync, mkdirSync } from "node:fs";
import {
  bootstrapMaterial,
  configForRoot,
  createFakeOpenRuntime,
  silentLogger,
} from "./support.js";
import { testPool } from "../support/store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-create-"));
  roots.push(hostRoot);
  const openRuntime = createFakeOpenRuntime({ hostRoot });
  const configFor = configForRoot(hostRoot);
  const store = createPostgresTenantStore({ hostRoot, sql: testPool(), openRuntime, configFor });
  const module = createTenantModule({ store, logger: silentLogger() });
  return { hostRoot, module, store };
}

it("create writes the Tenant, its bootstrap principal and its directory", async () => {
  const { hostRoot, module, store } = await setup();
  const id = newTenantId();
  const boot = bootstrapMaterial();
  const result = await module.create({
    tenantId: id,
    name: "fresh",
    ...boot,
  });
  expect(result.created).toBe(true);
  const paths = tenantPaths(hostRoot, id);
  expect(existsSync(paths.root)).toBe(true);
  expect(await store.bootstrapMatches(id, boot)).toBe(true);
  expect(await module.status(id)).toMatchObject({
    id,
    state: "open",
    name: "fresh",
  });
});

it("lost create response retries safely with identical material", async () => {
  const { module } = await setup();
  const id = newTenantId();
  const boot = bootstrapMaterial();
  const first = await module.create({ tenantId: id, name: "x", ...boot });
  const retry = await module.create({ tenantId: id, name: "x", ...boot });
  expect(first.created).toBe(true);
  expect(retry.created).toBe(false);
  expect(retry.envelope.createdAt).toBe(first.envelope.createdAt);
});

it("create with different material after collision is 409", async () => {
  const { module } = await setup();
  const id = newTenantId();
  await module.create({
    tenantId: id,
    name: "x",
    ...bootstrapMaterial(),
  });
  await expect(
    module.create({
      tenantId: id,
      name: "y",
      ...bootstrapMaterial({ credentialHash: "ef".repeat(32) }),
    }),
  ).rejects.toBeInstanceOf(TenantConflictError);
});

it("partial create is removed before the error propagates", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-partial-"));
  roots.push(hostRoot);
  const openRuntime = createFakeOpenRuntime({ hostRoot });
  const configFor = configForRoot(hostRoot);
  const postgres = createPostgresTenantStore({ hostRoot, sql: testPool(), openRuntime, configFor });
  // A create that fails after making the Tenant directory.
  const store: TenantStore = {
    ...postgres,
    async create(envelope) {
      mkdirSync(tenantPaths(hostRoot, envelope.id).root, { recursive: true });
      throw new Error("bootstrap failed");
    },
  };
  const module = createTenantModule({ store, logger: silentLogger() });
  const id = newTenantId();
  await expect(
    module.create({
      tenantId: id,
      name: "partial",
      ...bootstrapMaterial(),
    }),
  ).rejects.toThrow(/bootstrap failed/);
  expect(existsSync(tenantPaths(hostRoot, id).root)).toBe(false);
});
