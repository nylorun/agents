import { createHmac } from "node:crypto";

/**
 * Deterministic Studio key, derived from the admin key: HMAC-SHA256 over
 * `nylorun/studio/v2`. The same admin key always produces the same key. It names
 * no Tenant (protocol 8): Studio derives it before it learns the Tenant's id, and
 * an installation has one Tenant. Studio derives it in memory; the Tenant stores
 * only its hash, as principal `studio`. It is the only derived key.
 */
export function deriveStudioToken(adminKey: string): string {
  const message = Buffer.from("nylorun/studio/v2", "utf8");
  return createHmac("sha256", Buffer.from(adminKey, "utf8"))
    .update(message)
    .digest("hex");
}
