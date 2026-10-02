import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostPaths, tenantPaths } from "../src/tenant/paths.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function tempRoot() {
  // Real path, as tenantPaths derives it (macOS tmpdir is under the /var symlink).
  const root = await realpath(await mkdtemp(join(tmpdir(), "nylorun-paths-")));
  roots.push(root);
  return root;
}

it("derives host paths under the host root", async () => {
  const root = await tempRoot();
  const paths = hostPaths(root);
  expect(paths.config).toBe(join(root, "host.json"));
  expect(paths.credentials).toBe(join(root, "host-credentials.json"));
  expect(paths.tenant).toBe(join(root, "tenant"));
  expect(paths).not.toHaveProperty("tenants");
  expect(paths).not.toHaveProperty("trash");
});

it("derives the Tenant directory without an id segment", async () => {
  const root = await tempRoot();
  const paths = tenantPaths(root);
  expect(paths.root).toBe(join(root, "tenant"));
  // The vault key lives beside the Tenant directory, in keys/ (F4.2).
  expect(paths.kek).toBe(join(root, "keys", "vault-kek"));
  expect(paths.home).toBe(join(paths.root, "home"));
  expect(paths.log).toBe(join(paths.root, "logs", "tenant.log"));
});

it("rejects a Tenant directory that escapes the Host root via symlink", async () => {
  const root = await tempRoot();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "nylorun-paths-outside-")));
  roots.push(outside);
  await mkdir(join(outside, "x"));
  await writeFile(join(outside, "marker"), "x");
  await symlink(outside, join(root, "tenant"));
  expect(() => tenantPaths(root)).toThrow(/escapes/);
});
