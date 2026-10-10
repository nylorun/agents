/**
 * The principals the Host gives its Tenant when it creates it (tenancy.md §4): the Studio
 * principal, whose key the admin key derives, so Studio (and an app embedding it) stores none,
 * and, for the ephemeral Runtime, one application principal with a key of its own. The Tenant
 * keeps only their hashes. Every other key is put by name (`PUT /v1/tenant/keys/{keyId}`,
 * `nylorun-operate keys`, `operator-keys.ts`); no other key is derived.
 *
 * The derivation is the one `@nylorun/admin` computes on the client side
 * (`sdks/admin/src/derived-credentials.ts`: `deriveStudioToken`); both sides must stay byte for byte
 * the same.
 */
import { createHmac } from "node:crypto";
import { BOOTSTRAP_KEY_ID } from "@nylorun/core/compatibility";
import { hashToken } from "../core/bearer.js";
import type { InitialPrincipal } from "../store/postgres/tenant.js";

export type { PrincipalRow } from "../store/types.js";

/** Principal id of the Studio key derived from the admin key. */
export const STUDIO_PRINCIPAL_ID = "studio";

/**
 * The Studio key: HMAC-SHA256 of the admin key over `nylorun/studio/v2`. It names no Tenant
 * (protocol 8): Studio derives it before it can learn the Tenant's id, and the admin key is
 * already one per installation.
 */
export function deriveStudioKey(adminKey: string): string {
  return hmac(adminKey, ["nylorun/studio/v2"]);
}

/**
 * The principals a Host's Tenant is created with: `studio`, and an application principal when
 * a key is given (the ephemeral Runtime). Keys are hashed here.
 */
export function hostPrincipals(options: {
  adminKey: string;
  application?: { principalId: string; key: string };
  /** Registers `studio` with this hash instead of the admin key's derivation. */
  studioCredentialHash?: string;
  /**
   * The management key of `NYLORUN_MANAGEMENT_KEY_FILE`: registered as `bootstrap`, and
   * replaced at the next start when the file changed.
   */
  bootstrapKey?: string;
}): (tenantId: string) => InitialPrincipal[] {
  return () => [
    ...(options.bootstrapKey
      ? [
          {
            id: BOOTSTRAP_KEY_ID,
            role: "management" as const,
            credentialHash: hashToken(options.bootstrapKey),
            replace: true,
          },
        ]
      : []),
    ...(options.application
      ? [
          {
            id: options.application.principalId,
            credentialHash: hashToken(options.application.key),
          },
        ]
      : []),
    {
      id: STUDIO_PRINCIPAL_ID,
      // Studio runs sessions and edits the Tenant's settings: both APIs (protocol 8).
      role: "studio" as const,
      credentialHash: options.studioCredentialHash ?? hashToken(deriveStudioKey(options.adminKey)),
      // Its key derives from the admin key: a database holding an older derivation (v1, with
      // the Tenant id) takes this one at the next start.
      replace: true,
    },
  ];
}

/** HMAC-SHA256 (hex) of `parts` joined by NUL bytes, keyed with the admin key. */
function hmac(adminKey: string, parts: readonly string[]): string {
  const message = Buffer.concat(
    parts.flatMap((part, index) => [
      ...(index > 0 ? [Buffer.from([0])] : []),
      Buffer.from(part, "utf8"),
    ]),
  );
  return createHmac("sha256", Buffer.from(adminKey, "utf8")).update(message).digest("hex");
}
