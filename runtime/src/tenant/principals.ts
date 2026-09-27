import type { DatabaseSync } from "node:sqlite";
import type { BootstrapPrincipal } from "./types.js";

export interface PrincipalRow {
  id: string;
  role: "application";
  tokenHash: string;
  idempotencyKey: string | null;
  createdAt: string;
}

/** Principal id of the Studio key derived from the admin key. */
export const STUDIO_PRINCIPAL_ID = "studio";

/**
 * Writes the application principal and idempotency key in one transaction,
 * plus principal `studio` when the bootstrap carries a Studio credential hash.
 * Exported for WS-B's `TenantStore.create` (A3).
 */
export function bootstrapPrincipal(
  db: DatabaseSync,
  bootstrap: BootstrapPrincipal,
): void {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO principals(id, role, token_hash, idempotency_key, created_at)
       VALUES(?, 'application', ?, ?, ?)`,
    ).run(
      bootstrap.principalId,
      bootstrap.credentialHash,
      bootstrap.idempotencyKey,
      now,
    );
    if (bootstrap.studioCredentialHash)
      db.prepare(
        `INSERT INTO principals(id, role, token_hash, idempotency_key, created_at)
         VALUES(?, 'application', ?, NULL, ?)`,
      ).run(STUDIO_PRINCIPAL_ID, bootstrap.studioCredentialHash, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Whether the stored bootstrap (and Studio) principals equal `bootstrap`. */
export function bootstrapPrincipalMatches(
  db: DatabaseSync,
  bootstrap: BootstrapPrincipal,
): boolean {
  const select = db.prepare(
    `SELECT token_hash, idempotency_key FROM principals
     WHERE role = 'application' AND id = ?`,
  );
  const row = select.get(bootstrap.principalId) as
    | { token_hash: string; idempotency_key: string | null }
    | undefined;
  if (
    !row ||
    row.token_hash !== bootstrap.credentialHash ||
    row.idempotency_key !== bootstrap.idempotencyKey
  )
    return false;
  const studio = select.get(STUDIO_PRINCIPAL_ID) as
    | { token_hash: string }
    | undefined;
  return studio?.token_hash === bootstrap.studioCredentialHash;
}

export function findPrincipalByTokenHash(
  db: DatabaseSync,
  tokenHash: string,
): PrincipalRow | undefined {
  const row = db
    .prepare(
      `SELECT id, role, token_hash, idempotency_key, created_at
       FROM principals WHERE token_hash = ?`,
    )
    .get(tokenHash) as
    | {
        id: string;
        role: string;
        token_hash: string;
        idempotency_key: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    role: "application",
    tokenHash: String(row.token_hash),
    idempotencyKey:
      row.idempotency_key == null ? null : String(row.idempotency_key),
    createdAt: String(row.created_at),
  };
}

export function applicationTokenHashes(db: DatabaseSync): readonly string[] {
  return db
    .prepare(`SELECT token_hash FROM principals WHERE role = 'application'`)
    .all()
    .map((row) => String((row as { token_hash: string }).token_hash));
}

export function isApplicationTokenHash(
  db: DatabaseSync,
  tokenHash: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM principals WHERE role = 'application' AND token_hash = ?`,
    )
    .get(tokenHash);
  return !!row;
}
