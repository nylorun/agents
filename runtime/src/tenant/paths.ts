import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { TenantPaths } from "./types.js";

export interface HostPaths {
  root: string;
  config: string; // host.json
  credentials: string; // host-credentials.json
  home: string;
  tmp: string;
  /** The Tenant directory (`tenantPaths`). */
  tenant: string;
}

function assertContained(parent: string, child: string): void {
  const root = parent.endsWith(sep) ? parent : parent + sep;
  if (child !== parent && !child.startsWith(root)) {
    throw new Error(`Path ${child} escapes the Host root ${parent}`);
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
    tenant: join(root, "tenant"),
  };
}

/**
 * Absolute paths of the Tenant directory, `<hostRoot>/tenant/`: a Host serves one Tenant
 * (tenancy.md §1), so the directory has no id segment. Asserts that it stays inside the Host
 * root after realpath.
 *
 * The directory holds what stays on the Host (the Tenant's data is its database):
 * `vault-kek`, `home/`, `tmp/`, `sandboxes/`, `plugin-data/`, `logs/tenant.log`.
 */
export function tenantPaths(hostRoot: string): TenantPaths {
  mkdirSync(hostRoot, { recursive: true });
  const host = realpathSync(hostRoot);
  const root = join(host, "tenant");
  if (existsSync(root)) assertContained(host, realpathSync(root));
  return {
    root,
    kek: join(root, "vault-kek"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    sandboxes: join(root, "sandboxes"),
    pluginData: join(root, "plugin-data"),
    logs: join(root, "logs"),
    log: join(root, "logs", "tenant.log"),
  };
}
