import { createHash } from "node:crypto";
import { TENANT_ID_PATTERN } from "@nylorun/core/compatibility";

/**
 * S2 basin names for Tenants (architecture §12.4).
 *
 * S2 basin names are 8–48 characters of lowercase letters, digits and hyphens,
 * and cannot begin or end with a hyphen. Tenant ids are `tn_` plus a 26
 * character lowercase ULID, and `_` is not allowed, so:
 *
 * - a canonical Tenant id `tn_<ulid>` maps to `<prefix>tn-<ulid>` (29
 *   characters plus the prefix). The ULID contains no hyphen, so the mapping is
 *   one-to-one and readable in S2 tooling;
 * - any other id (tests, legacy ids) maps to `<prefix>x-<slug>-<hash>`, where
 *   `slug` is the id lowercased with every run of other characters replaced by
 *   `-` (at most 12 characters) and `hash` is the first 16 hex digits of the
 *   id's SHA-256. The `x-` start keeps these apart from canonical names, and the
 *   hash keeps ids that slug alike apart.
 *
 * `prefix` separates deployments or test runs that share one S2 account (basin
 * names are global in S2). It must itself be lowercase letters, digits and
 * hyphens, start with a letter or digit, and be at most 16 characters.
 */
export const MAX_BASIN_PREFIX_LENGTH = 16;

const BASIN_NAME = /^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$/;
const BASIN_PREFIX = /^(?:[a-z0-9][a-z0-9-]*)?$/;

export function validateBasinPrefix(prefix: string): string {
  if (prefix.length > MAX_BASIN_PREFIX_LENGTH || !BASIN_PREFIX.test(prefix))
    throw new Error(
      `S2 basin prefix must be at most ${MAX_BASIN_PREFIX_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit`,
    );
  return prefix;
}

export function tenantBasinName(tenantId: string, prefix = ""): string {
  validateBasinPrefix(prefix);
  if (!tenantId) throw new Error("tenantId is required");
  let name: string;
  if (TENANT_ID_PATTERN.test(tenantId)) {
    name = `${prefix}tn-${tenantId.slice(3)}`;
  } else {
    const slug = tenantId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 12)
      .replace(/^-+|-+$/g, "");
    const hash = createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
    name = `${prefix}x-${slug ? `${slug}-` : ""}${hash}`;
  }
  if (!BASIN_NAME.test(name)) throw new Error(`Invalid S2 basin name ${name}`);
  return name;
}
