import { createHmac } from "node:crypto";

/**
 * Deterministic Studio key for one Tenant, derived from the admin key.
 * Same admin key and Tenant always produce the same key. Studio derives it in
 * memory; the Tenant stores only its hash, as principal `studio`.
 */
export function deriveStudioToken(adminKey: string, tenantId: string): string {
  const message = Buffer.concat([
    Buffer.from("nylorun/studio/v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(tenantId, "utf8"),
  ]);
  return createHmac("sha256", Buffer.from(adminKey, "utf8"))
    .update(message)
    .digest("hex");
}

/**
 * Deterministic key of a derived principal (`principalId`, e.g. `babai`) on one Tenant,
 * derived from the admin key. The Tenant stores only its hash, registered when the Tenant
 * is created with `principals` (feature `derived-principals`); the client recomputes the
 * key when it needs it and stores nothing. Rotating the admin key rotates every derived key.
 */
export function deriveTenantKey(
  adminKey: string,
  tenantId: string,
  principalId: string,
): string {
  const message = Buffer.concat([
    Buffer.from("nylorun/principal/v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(principalId, "utf8"),
    Buffer.from([0]),
    Buffer.from(tenantId, "utf8"),
  ]);
  return createHmac("sha256", Buffer.from(adminKey, "utf8"))
    .update(message)
    .digest("hex");
}
