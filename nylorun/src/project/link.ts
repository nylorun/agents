import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isTenantId } from "@nylorun/core/compatibility";
import { findProjectRoot } from "./root.js";

/**
 * The linked Project's Tenant id, read from `.nylorun/link.json`, or undefined
 * outside a linked Project. nylorun only reads the link: `@nylorun/cli` writes
 * it when it creates or chooses a Tenant.
 */
export async function linkedTenantId(cwd = process.cwd()): Promise<string | undefined> {
  const root = findProjectRoot(cwd);
  if (!root) return undefined;
  try {
    const link = JSON.parse(await readFile(join(root, ".nylorun", "link.json"), "utf8")) as {
      tenantId?: unknown;
    };
    return isTenantId(link.tenantId) ? link.tenantId : undefined;
  } catch {
    return undefined;
  }
}
