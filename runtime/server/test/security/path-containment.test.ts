/**
 * G7 — Path containment after normalisation/symlinks.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { tenantPaths } from "../../src/tenant/paths.js";
import { startSecurityHost } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("G7: tenantPaths rejects a Tenant directory that is a symlink out of the Host root", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "sec-path-"));
  roots.push(hostRoot);
  const outside = await mkdtemp(join(tmpdir(), "sec-path-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "marker"), "x");
  symlinkSync(outside, join(hostRoot, "tenant"));
  expect(() => tenantPaths(hostRoot)).toThrow(/escapes/);
});

it("G7: a symlinked Tenant directory inside the Host root is allowed", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "sec-path-"));
  roots.push(hostRoot);
  mkdirSync(join(hostRoot, "data"));
  symlinkSync(join(hostRoot, "data"), join(hostRoot, "tenant"));
  expect(tenantPaths(hostRoot).home).toMatch(/tenant\/home$/);
});

it("G7: the live Tenant directory is hostRoot/tenant", async () => {
  const host = await startSecurityHost();
  const a = host.tenant;
  expect(a.paths.root).toBe(join(host.hostRoot, "tenant"));
  expect(a.paths.home).toBe(join(host.hostRoot, "tenant", "home"));
  expect(a.paths.kek).toBe(join(host.hostRoot, "keys", "vault-kek"));
});
