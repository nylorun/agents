/**
 * Tenant id ↔ Postgres schema name (architecture §8.1, §12.2).
 *
 * A Tenant's Session Store is the schema `"tenant_<id>"`, for example
 * `tn_01k8z3…` ↦ `"tenant_tn_01k8z3…"`. Tenant ids match
 * `^tn_[0-9a-hjkmnp-tv-z]{26}$` (lowercase ASCII), so the name is 36 bytes,
 * under Postgres' 63-byte identifier limit, and needs no case folding. It is
 * always written quoted. The mapping is total and reversible: a schema that
 * starts with `tenant_` but does not decode to a valid Tenant id is not a
 * Tenant.
 */
import { isTenantId } from "@nylorun/core/compatibility";

export const TENANT_SCHEMA_PREFIX = "tenant_";

/** Postgres truncates identifiers longer than NAMEDATALEN - 1 bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

/** The schema holding `tenantId`'s Session Store. Throws on an invalid id. */
export function tenantSchemaName(tenantId: string): string {
  if (!isTenantId(tenantId)) throw new Error(`Invalid tenant id: ${tenantId}`);
  const schema = `${TENANT_SCHEMA_PREFIX}${tenantId}`;
  assertIdentifier(schema);
  return schema;
}

/** The Tenant id a schema name encodes, or undefined when it is not a Tenant schema. */
export function tenantIdFromSchema(schema: string): string | undefined {
  if (!schema.startsWith(TENANT_SCHEMA_PREFIX)) return undefined;
  const id = schema.slice(TENANT_SCHEMA_PREFIX.length);
  return isTenantId(id) ? id : undefined;
}

/** Rejects names Postgres would truncate or that could not be quoted safely. */
export function assertIdentifier(name: string): void {
  if (
    name.length === 0 ||
    Buffer.byteLength(name, "utf8") > MAX_IDENTIFIER_BYTES ||
    !/^[a-z_][a-z0-9_]*$/.test(name)
  )
    throw new Error(`Invalid Postgres identifier: ${name}`);
}

/** `"name"`, for SQL text built outside a tagged template (migrations). */
export function quoteIdentifier(name: string): string {
  assertIdentifier(name);
  return `"${name}"`;
}
