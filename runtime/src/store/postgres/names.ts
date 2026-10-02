/**
 * The fixed schema names of a Tenant database (session-store.md §2). One database holds one
 * Tenant: its state is the schema `nylorun`, its record `nylorun_streams`
 * (`migrations/shared/`). Neither name varies.
 */

/** The schema holding the Tenant's state: the `tenant` row, sessions, principals, vaults, … */
export const TENANT_SCHEMA = "nylorun";

/**
 * What schemas were called when one database held several Tenants (`"tenant_<id>"`). A
 * database that still has one was written by an older Runtime and is refused
 * (`database-layout-old`).
 */
export const OLD_TENANT_SCHEMA_PREFIX = "tenant_";

/** Postgres truncates identifiers longer than NAMEDATALEN - 1 bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

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
