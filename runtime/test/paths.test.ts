import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { hostPaths, tenantPaths } from "../src/tenant/paths.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "nylorun-paths-"));
  roots.push(root);
  return root;
}

it("derives host paths under the host root", async () => {
  const root = await tempRoot();
  const paths = hostPaths(root);
  expect(paths.config).toBe(join(root, "host.json"));
  expect(paths.credentials).toBe(join(root, "host-credentials.json"));
  expect(paths.tenants).toBe(join(root, "tenants"));
  expect(paths.trash).toBe(join(root, "trash"));
});

it("derives tenant paths and rejects invalid ids", async () => {
  const root = await tempRoot();
  const id = newTenantId();
  const paths = tenantPaths(root, id);
  expect(paths.root).toBe(join(root, "tenants", id));
  expect(paths.kek).toBe(join(paths.root, "vault-kek"));
  expect(paths.log).toBe(join(paths.root, "logs", "tenant.log"));
  expect(() => tenantPaths(root, "not-a-tenant")).toThrow(/Invalid tenant id/);
});

it("rejects a tenant directory that escapes tenants via symlink", async () => {
  const root = await tempRoot();
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "marker"), "x");
  const tenants = join(root, "tenants");
  await mkdir(tenants);
  const id = newTenantId();
  await symlink(outside, join(tenants, id));
  expect(() => tenantPaths(root, id)).toThrow(/escapes/);
});
