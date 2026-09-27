import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isTenantId } from "@nylorun/core/compatibility";
import type { TenantPaths } from "./types.js";

export interface HostPaths {
  root: string;
  config: string; // host.json
  state: string; // host-state.json
  credentials: string; // host-credentials.json
  log: string; // runtime.log
  home: string;
  tmp: string;
  runtime: string;
  tenants: string;
  trash: string;
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

function assertContained(parent: string, child: string): void {
  const root = parent.endsWith(sep) ? parent : parent + sep;
  if (child !== parent && !child.startsWith(root)) {
    throw new Error(
      `Path ${child} escapes host tenants root ${parent}`,
    );
  }
}

/** Host layout under NYLORUN_HOME / ~/.nylorun. */
export function hostPaths(hostRoot: string): HostPaths {
  const root = resolve(hostRoot);
  return {
    root,
    config: join(root, "host.json"),
    state: join(root, "host-state.json"),
    credentials: join(root, "host-credentials.json"),
    log: join(root, "runtime.log"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    runtime: join(root, "runtime"),
    tenants: join(root, "tenants"),
    trash: join(root, "trash"),
  };
}

/**
 * Absolute Tenant paths under `<hostRoot>/tenants/<tenantId>/`.
 * Validates the id and asserts containment after realpath.
 *
 * Basenames frozen here for Wave 0 (design Rev 3 absent):
 * `tenant.json`, `tenant.sqlite`, `vault-kek`,
 * `home/`, `tmp/`, `.migration/`, `sandboxes/`, `plugin-data/`, `logs/tenant.log`.
 */
export function tenantPaths(hostRoot: string, tenantId: string): TenantPaths {
  if (!isTenantId(tenantId)) {
    throw new Error(`Invalid tenant id: ${String(tenantId)}`);
  }
  const host = hostPaths(hostRoot);
  const tenantsRoot = ensureDir(host.tenants);
  const root = join(tenantsRoot, tenantId);
  // Containment before the Tenant directory exists: resolve under real tenants root.
  const resolvedRoot = resolve(tenantsRoot, tenantId);
  assertContained(tenantsRoot, resolvedRoot);
  if (existsSync(root)) {
    assertContained(tenantsRoot, realpathSync(root));
  }
  return {
    root: resolvedRoot,
    envelope: join(resolvedRoot, "tenant.json"),
    database: join(resolvedRoot, "tenant.sqlite"),
    kek: join(resolvedRoot, "vault-kek"),
    home: join(resolvedRoot, "home"),
    tmp: join(resolvedRoot, "tmp"),
    migration: join(resolvedRoot, ".migration"),
    sandboxes: join(resolvedRoot, "sandboxes"),
    pluginData: join(resolvedRoot, "plugin-data"),
    logs: join(resolvedRoot, "logs"),
    log: join(resolvedRoot, "logs", "tenant.log"),
  };
}
