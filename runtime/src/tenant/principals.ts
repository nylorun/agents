import type { Tx } from "../store/types.js";
import type { BootstrapPrincipal } from "./types.js";

export type { PrincipalRow } from "../store/types.js";

/** Principal id of the Studio key derived from the admin key. */
export const STUDIO_PRINCIPAL_ID = "studio";

/**
 * Writes the application principal and idempotency key in the caller's transaction, plus
 * principal `studio` when the bootstrap carries a Studio credential hash.
 * Exported for WS-B's `TenantStore.create` (A3).
 */
export async function bootstrapPrincipal(
  t: Tx,
  bootstrap: BootstrapPrincipal,
  now = new Date(),
): Promise<void> {
  const createdAt = now.toISOString();
  await t.insertPrincipal({
    id: bootstrap.principalId,
    role: "application",
    tokenHash: bootstrap.credentialHash,
    idempotencyKey: bootstrap.idempotencyKey,
    createdAt,
  });
  if (bootstrap.studioCredentialHash)
    await t.insertPrincipal({
      id: STUDIO_PRINCIPAL_ID,
      role: "application",
      tokenHash: bootstrap.studioCredentialHash,
      idempotencyKey: null,
      createdAt,
    });
}

/** Whether the stored bootstrap (and Studio) principals equal `bootstrap`. */
export async function bootstrapPrincipalMatches(
  t: Tx,
  bootstrap: BootstrapPrincipal,
): Promise<boolean> {
  const row = await t.principalById(bootstrap.principalId);
  if (
    !row ||
    row.role !== "application" ||
    row.tokenHash !== bootstrap.credentialHash ||
    row.idempotencyKey !== bootstrap.idempotencyKey
  )
    return false;
  const studio = await t.principalById(STUDIO_PRINCIPAL_ID);
  return (
    (studio?.role === "application" ? studio.tokenHash : undefined) ===
    bootstrap.studioCredentialHash
  );
}
