import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { isTenantId } from "@nylorun/core/compatibility";
import type { Logger, TenantPaths } from "./types.js";

export interface HostPaths {
  root: string;
  config: string; // host.json
  credentials: string; // host-credentials.json
  home: string;
  tmp: string;
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
    credentials: join(root, "host-credentials.json"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    tenants: join(root, "tenants"),
    trash: join(root, "trash"),
  };
}

/**
 * Absolute Tenant directory paths under `<hostRoot>/tenants/<tenantId>/`.
 * Validates the id and asserts containment after realpath.
 *
 * The directory holds what stays on the Host (the Tenant's data is its Postgres schema):
 * `vault-kek`, `home/`, `tmp/`, `sandboxes/`, `plugin-data/`, `logs/tenant.log`.
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
    kek: join(resolvedRoot, "vault-kek"),
    home: join(resolvedRoot, "home"),
    tmp: join(resolvedRoot, "tmp"),
    sandboxes: join(resolvedRoot, "sandboxes"),
    pluginData: join(resolvedRoot, "plugin-data"),
    logs: join(resolvedRoot, "logs"),
    log: join(resolvedRoot, "logs", "tenant.log"),
  };
}

/** The database file of a Tenant from before the Postgres Session Store. */
const SQLITE_DATABASE = "tenant.sqlite";

/**
 * Moves every Tenant directory that holds a `tenant.sqlite` to `trash/`, logging each.
 *
 * Those are beta Tenants from the SQLite Runtime. They are not migrated (recreate them); a
 * Postgres Tenant's directory never holds that file. Moving them at Host start keeps a new
 * Postgres Tenant with the same id from sharing the old directory. Returns the moved ids.
 */
export function trashSqliteTenants(hostRoot: string, logger: Logger): string[] {
  const host = hostPaths(hostRoot);
  if (!existsSync(host.tenants)) return [];
  const moved: string[] = [];
  const stamp = new Date().toISOString().replaceAll(":", "-");
  for (const entry of readdirSync(host.tenants, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(host.tenants, entry.name);
    if (!existsSync(join(directory, SQLITE_DATABASE))) continue;
    mkdirSync(host.trash, { recursive: true });
    const destination = join(host.trash, `${entry.name}-sqlite-${stamp}`);
    renameSync(directory, destination);
    moved.push(entry.name);
    logger.warn("sqlite_tenant_moved_to_trash", {
      tenant: entry.name,
      from: directory,
      to: destination,
      reason:
        "SQLite Tenants are not migrated to the Postgres Session Store; recreate the Tenant",
    });
  }
  return moved;
}
