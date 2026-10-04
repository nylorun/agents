/**
 * Operator keys (F9 I1, Host feature `operator-keys`): the Tenant's application keys, managed
 * by name through the Admin API. A key is a principal (F9-D11): its id is the key's name
 * (`DERIVED_PRINCIPAL_ID_PATTERN`), the key is 64 hex characters (`mintBearerToken`), and the
 * Tenant keeps only its SHA-256. Putting a key creates the principal or rotates its key;
 * deleting it removes the row. Either way the old key stops authenticating on its next request,
 * since authentication reads the principal on every request (`auth.ts`).
 *
 * `studio` is derived from the admin key (F9-D9): it is never put or deleted here.
 */
import { DERIVED_PRINCIPAL_ID_PATTERN } from "@nylorun/core/compatibility";
import type { OperatorKey, PutOperatorKeyResponse } from "@nylorun/core/contracts";
import { hashToken, mintBearerToken } from "../core/bearer.js";
import type { SessionStore } from "../store/types.js";
import { STUDIO_PRINCIPAL_ID } from "./principals.js";

/** Why a key id is refused: not a key name, or the reserved `studio`. */
export type OperatorKeyRefusal = { reason: "invalid" | "reserved"; message: string };

/** The refusal for `id`, or undefined when operator keys may use it. */
export function refuseOperatorKeyId(id: string): OperatorKeyRefusal | undefined {
  if (!DERIVED_PRINCIPAL_ID_PATTERN.test(id))
    return {
      reason: "invalid",
      message: `A key id must match ${DERIVED_PRINCIPAL_ID_PATTERN.source}`,
    };
  if (id === STUDIO_PRINCIPAL_ID)
    return {
      reason: "reserved",
      message: "The studio key is derived from the admin key: it is not put or deleted here",
    };
  return undefined;
}

export interface OperatorKeys {
  /** Every principal of the Tenant, by id (Studio's and derived ones included). */
  list(): Promise<OperatorKey[]>;
  /** Creates key `id` or rotates it; the key is returned this once. */
  put(id: string): Promise<PutOperatorKeyResponse | OperatorKeyRefusal>;
  /** Deletes key `id`: false when there is none. */
  delete(id: string): Promise<boolean | OperatorKeyRefusal>;
}

export function operatorKeys(
  store: SessionStore,
  now: () => string = () => new Date().toISOString(),
): OperatorKeys {
  return {
    async list() {
      const rows = await store.tx((t) => t.listPrincipals());
      return rows.map(({ id, role, createdAt }) => ({ id, role, createdAt }));
    },
    async put(id) {
      const refused = refuseOperatorKeyId(id);
      if (refused) return refused;
      const key = mintBearerToken();
      const { row, rotated } = await store.tx(async (t) => {
        const existing = await t.principalById(id);
        return {
          row: await t.putPrincipal(id, hashToken(key), now()),
          rotated: existing !== undefined,
        };
      });
      return { id: row.id, role: row.role, createdAt: row.createdAt, key, rotated };
    },
    async delete(id) {
      const refused = refuseOperatorKeyId(id);
      if (refused) return refused;
      return await store.tx((t) => t.deletePrincipal(id));
    },
  };
}
