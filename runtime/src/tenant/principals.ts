/**
 * The principals the Host gives its Tenant when it creates it (tenancy.md §4): the Studio
 * principal, whose key the admin key derives, so Studio (and an app embedding it) stores none,
 * and, for the ephemeral Runtime, one application principal with a key of its own. The Tenant
 * keeps only their hashes. Every other application key is an operator key
 * (`PUT /v1/admin/keys/{id}`, `operator-keys.ts`); no other key is derived.
 *
 * The derivation is the one `@nylorun/admin` computes on the client side
 * (`admin/src/derived-credentials.ts`: `deriveStudioToken`); both sides must stay byte for byte
 * the same.
 */
import { createHmac } from "node:crypto";
import { hashToken } from "../core/bearer.js";
import type { InitialPrincipal } from "../store/postgres/tenant.js";

export type { PrincipalRow } from "../store/types.js";

/** Principal id of the Studio key derived from the admin key. */
export const STUDIO_PRINCIPAL_ID = "studio";

/** The Studio key of `tenantId`: HMAC-SHA256 of the admin key. */
export function deriveStudioKey(adminKey: string, tenantId: string): string {
  return hmac(adminKey, ["nylorun/studio/v1", tenantId]);
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
}): (tenantId: string) => InitialPrincipal[] {
  return (tenantId) => [
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
      credentialHash:
        options.studioCredentialHash ??
        hashToken(deriveStudioKey(options.adminKey, tenantId)),
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
