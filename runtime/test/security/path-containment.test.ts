/**
 * G7 — Path containment after normalisation/symlinks.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { tenantPaths } from "../../src/tenant/paths.js";
import { startSecurityHost } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("G7: tenantPaths rejects symlink escape after realpath", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "sec-path-"));
  roots.push(hostRoot);
  const outside = join(hostRoot, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "marker"), "x");
  const tenants = join(hostRoot, "tenants");
  mkdirSync(tenants);
  const id = newTenantId();
  symlinkSync(outside, join(tenants, id));
  expect(() => tenantPaths(hostRoot, id)).toThrow(/escapes/);
});

it("G7: tenantPaths rejects invalid ids before path joins", () => {
  expect(() => tenantPaths("/tmp/host", "../etc")).toThrow(/Invalid tenant id/);
  expect(() => tenantPaths("/tmp/host", "tn_short")).toThrow(/Invalid tenant id/);
});

it("G7: live Tenant directories stay under hostRoot/tenants/<id>", async () => {
  const host = await startSecurityHost();
  const [a] = host.tenants;
  expect(a.paths.root.startsWith(join(host.hostRoot, "tenants", a.id))).toBe(
    true,
  );
  expect(a.paths.home.includes(join("tenants", a.id, "home"))).toBe(true);
  expect(a.paths.kek.includes(join("tenants", a.id))).toBe(true);
});
