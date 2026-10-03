import { createHmac } from "node:crypto";

/** The derived principal a Project uses; the local Runtime registers it on its Tenant. */
export const PROJECT_PRINCIPAL_ID = "project";

/**
 * Key of a derived principal on the local Tenant, from the admin key. A copy of
 * `deriveTenantKey` in `@nylorun/admin` (nylorun depends on `@nylorun/core` only); both are
 * tested against the same fixed vector.
 */
export function deriveTenantKey(adminKey: string, tenantId: string, principalId: string): string {
  const message = Buffer.concat([
    Buffer.from("nylorun/principal/v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(principalId, "utf8"),
    Buffer.from([0]),
    Buffer.from(tenantId, "utf8"),
  ]);
  return createHmac("sha256", Buffer.from(adminKey, "utf8")).update(message).digest("hex");
}
