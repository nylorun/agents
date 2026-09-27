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
