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

/**
 * The basin of one generation of a Tenant (Durable Streams §8.1). A Tenant reset moves the
 * Tenant to a new generation, so a session id it frees starts again in an empty basin.
 * `DurableStreams` methods take this key where they take a Tenant id; generation 0 is the
 * Tenant id itself, so existing basins keep their names.
 */
export function basinOf(tenantId: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0)
    throw new Error("A basin generation is a non-negative integer");
  return generation === 0 ? tenantId : `${tenantId}${GENERATION_SEPARATOR}${generation}`;
}

/** The Tenant id and generation of a basin key from `basinOf`. */
export function parseBasin(basin: string): { tenantId: string; generation: number } {
  const at = basin.lastIndexOf(GENERATION_SEPARATOR);
  const generation = at < 0 ? NaN : Number(basin.slice(at + 1));
  return Number.isInteger(generation) && generation > 0
    ? { tenantId: basin.slice(0, at), generation }
    : { tenantId: basin, generation: 0 };
}

/** Never in a Tenant id (`TENANT_ID_PATTERN`). */
const GENERATION_SEPARATOR = "#";

/**
 * The S2 basin of a Tenant, or of one of its generations (`basinOf`). Generation `g` > 0 of
 * a canonical Tenant appends `-<g mod 1296 in base36>`, at most 48 characters with a
 * 16-character prefix; other ids fold the generation into their hash.
 */
export function tenantBasinName(basin: string, prefix = ""): string {
  validateBasinPrefix(prefix);
  const { tenantId, generation } = parseBasin(basin);
  if (!tenantId) throw new Error("tenantId is required");
  let name: string;
  if (TENANT_ID_PATTERN.test(tenantId)) {
    name = `${prefix}tn-${tenantId.slice(3)}`;
    if (generation > 0) name += `-${(generation % 1296).toString(36)}`;
  } else {
    const slug = tenantId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 12)
      .replace(/^-+|-+$/g, "");
    const hash = createHash("sha256")
      .update(generation > 0 ? basin : tenantId)
      .digest("hex")
      .slice(0, 16);
    name = `${prefix}x-${slug ? `${slug}-` : ""}${hash}`;
  }
  if (!BASIN_NAME.test(name)) throw new Error(`Invalid S2 basin name ${name}`);
  return name;
}
