/**
 * The principals the Host gives its Tenant when it creates it (tenancy.md §4, plan P9): the
 * Studio principal and the derived principals, whose keys the admin key derives, so the
 * clients holding the admin key (Studio, `nylorun start`, Babai) store none. The Tenant keeps
 * only their hashes.
 *
 * The derivations are the ones `@nylorun/admin` computes on the client side
 * (`admin/src/derived-credentials.ts`: `deriveStudioToken`, `deriveTenantKey`); both sides
 * must stay byte for byte the same.
 */
import { createHmac } from "node:crypto";
import { DERIVED_PRINCIPAL_ID_PATTERN } from "@nylorun/core/compatibility";
import { hashToken } from "../core/bearer.js";
import type { InitialPrincipal } from "../store/postgres/tenant.js";

export type { PrincipalRow } from "../store/types.js";

/** Principal id of the Studio key derived from the admin key. */
export const STUDIO_PRINCIPAL_ID = "studio";

/** The derived principal Projects use (`PROJECT_PRINCIPAL_ID` in `@nylorun/admin`). */
export const PROJECT_PRINCIPAL_ID = "project";

/** The derived principals a Host registers when not told otherwise. */
export const DEFAULT_DERIVED_PRINCIPALS: readonly string[] = [PROJECT_PRINCIPAL_ID];

/** The Studio key of `tenantId`: HMAC-SHA256 of the admin key. */
export function deriveStudioKey(adminKey: string, tenantId: string): string {
  return hmac(adminKey, ["nylorun/studio/v1", tenantId]);
}

/** The key of derived principal `principalId` on `tenantId`: HMAC-SHA256 of the admin key. */
export function deriveTenantKey(
  adminKey: string,
  tenantId: string,
  principalId: string,
): string {
  return hmac(adminKey, ["nylorun/principal/v1", principalId, tenantId]);
}

/** Whether `id` may name a derived principal: the client's name, never `studio`. */
export function isDerivedPrincipalId(id: string): boolean {
  return DERIVED_PRINCIPAL_ID_PATTERN.test(id) && id !== STUDIO_PRINCIPAL_ID;
}

/**
 * The principals a Host's Tenant is created with: `studio`, each derived principal, and an
 * application principal when a key is given (the ephemeral Runtime). Keys are hashed here.
 */
export function hostPrincipals(options: {
  adminKey: string;
  derived?: readonly string[];
  application?: { principalId: string; key: string };
  /** Registers `studio` with this hash instead of the admin key's derivation. */
  studioCredentialHash?: string;
}): (tenantId: string) => InitialPrincipal[] {
  const derived = options.derived ?? DEFAULT_DERIVED_PRINCIPALS;
  for (const id of derived)
    if (!isDerivedPrincipalId(id))
      throw new Error(
        `Derived principal id '${id}' must match ${DERIVED_PRINCIPAL_ID_PATTERN} and not be '${STUDIO_PRINCIPAL_ID}'`,
      );
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
    ...[...new Set(derived)].map((id) => ({
      id,
      credentialHash: hashToken(deriveTenantKey(options.adminKey, tenantId, id)),
    })),
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
