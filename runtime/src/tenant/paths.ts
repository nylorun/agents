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
 * The directory holds what stays on the Host (the Tenant's data is its database): `home/`,
 * `tmp/`, `sandboxes/`, `plugin-data/`, `blobs/` (the `fs` BlobStore, when the Host has no
 * Object store), `logs/tenant.log`. The vault key is the one exception:
 * it lives beside the Tenant directory, in `<hostRoot>/keys/vault-kek`, which the local stack
 * mounts only into the gateway (F4.2), never into the runtime container.
 */
export function tenantPaths(hostRoot: string): TenantPaths {
  mkdirSync(hostRoot, { recursive: true });
  const host = realpathSync(hostRoot);
  const root = join(host, "tenant");
  if (existsSync(root)) assertContained(host, realpathSync(root));
  return {
    root,
    kek: join(host, "keys", "vault-kek"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    sandboxes: join(root, "sandboxes"),
    pluginData: join(root, "plugin-data"),
    blobs: join(root, "blobs"),
    logs: join(root, "logs"),
    log: join(root, "logs", "tenant.log"),
  };
}
