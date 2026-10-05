/**
 * The Tenant's keys by name (F9 I1), managed through the Management API (`/v1/tenant/keys`,
 * application keys only) and `nylorun-operate keys`. A key is a principal (F9-D11): its id is the key's name
 * (`APPLICATION_KEY_ID_PATTERN`), the key is 64 hex characters (`mintBearerToken`), and the
 * Tenant keeps only its SHA-256. Putting a key creates the principal or rotates its key;
 * deleting it removes the row. Either way the old key stops authenticating on its next request,
 * since authentication reads the principal on every request (`auth.ts`).
 *
 * `studio` is derived from the admin key (F9-D9): it is never put or deleted here. `bootstrap` is
 * the management key a Host registers from `NYLORUN_MANAGEMENT_KEY_FILE`: its file is its only
 * source. A key has a role (protocol 8): `application` reaches the Runtime API, `management` the
 * Management API; a key keeps its role when it is rotated.
 */
import {
  APPLICATION_KEY_ID_PATTERN,
  BOOTSTRAP_KEY_ID,
  type KeyRole,
} from "@nylorun/core/compatibility";
import type { OperatorKey, PutOperatorKeyResponse } from "@nylorun/core/contracts";
import { hashToken, mintBearerToken } from "../core/bearer.js";
import { PrincipalRoleConflict } from "../store/ownership.js";
import type { SessionStore } from "../store/types.js";
import { STUDIO_PRINCIPAL_ID } from "./principals.js";

/**
 * Why a key is refused: not a key name, a reserved id (`studio`, `bootstrap`), or an id that
 * holds the other role (`role`).
 */
export type OperatorKeyRefusal = { reason: "invalid" | "reserved" | "role"; message: string };

/** The refusal for `id`, or undefined when operator keys may use it. */
export function refuseOperatorKeyId(id: string): OperatorKeyRefusal | undefined {
  if (!APPLICATION_KEY_ID_PATTERN.test(id))
    return {
      reason: "invalid",
      message: `A key id must match ${APPLICATION_KEY_ID_PATTERN.source}`,
    };
  if (id === STUDIO_PRINCIPAL_ID)
    return {
      reason: "reserved",
      message: "The studio key is derived from the admin key: it is not put or deleted here",
    };
  if (id === BOOTSTRAP_KEY_ID)
    return {
      reason: "reserved",
      message: "The bootstrap key comes from NYLORUN_MANAGEMENT_KEY_FILE: change that file to rotate it",
    };
  return undefined;
}

export interface OperatorKeys {
  /** Every principal of the Tenant, by id (Studio's and derived ones included). */
  list(): Promise<OperatorKey[]>;
  /**
   * Creates key `id` with `role` (default `application`) or rotates it; the key is returned
   * this once. An id that holds the other role is refused.
   */
  put(id: string, role?: Exclude<KeyRole, "studio">): Promise<PutOperatorKeyResponse | OperatorKeyRefusal>;
  /**
   * Deletes key `id`: false when there is none. With `role`, a key of another role is refused
   * (the Management API deletes application keys only).
   */
  delete(id: string, role?: Exclude<KeyRole, "studio">): Promise<boolean | OperatorKeyRefusal>;
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
    async put(id, role = "application") {
      const refused = refuseOperatorKeyId(id);
      if (refused) return refused;
      const key = mintBearerToken();
      try {
        const { row, rotated } = await store.tx(async (t) => {
          const existing = await t.principalById(id);
          return {
            row: await t.putPrincipal(id, hashToken(key), now(), role),
            rotated: existing !== undefined,
          };
        });
        return { id: row.id, role: row.role, createdAt: row.createdAt, key, rotated };
      } catch (error) {
        if (error instanceof PrincipalRoleConflict)
          return {
            reason: "role",
            message: `Key ${id} is not a${role === "application" ? "n application" : " management"} key: delete it first, or choose another name`,
          };
        throw error;
      }
    },
    async delete(id, role) {
      const refused = refuseOperatorKeyId(id);
      if (refused) return refused;
      return await store.tx(async (t) => {
        if (role !== undefined) {
          const existing = await t.principalById(id);
          if (existing && existing.role !== role)
            return {
              reason: "role" as const,
              message: `Key ${id} is a ${existing.role} key: only the Tenant's machine manages it (nylorun-operate)`,
            };
        }
        return await t.deletePrincipal(id);
      });
    },
  };
}
