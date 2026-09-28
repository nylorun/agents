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
  for (const principal of bootstrap.derivedPrincipals ?? [])
    await t.insertPrincipal({
      id: principal.id,
      role: "application",
      tokenHash: principal.credentialHash,
      idempotencyKey: null,
      createdAt,
    });
}

/**
 * Whether the stored bootstrap, Studio and derived principals equal `bootstrap`. A retried
 * create names the same derived principals, so each must be stored with its hash.
 */
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
  if (
    (studio?.role === "application" ? studio.tokenHash : undefined) !==
    bootstrap.studioCredentialHash
  )
    return false;
  for (const principal of bootstrap.derivedPrincipals ?? []) {
    const stored = await t.principalById(principal.id);
    if (
      stored?.role !== "application" ||
      stored.tokenHash !== principal.credentialHash
    )
      return false;
  }
  return true;
}
