import type {
  AdminStatus,
  HostTenant,
  OperatorKey,
  PutOperatorKeyResponse,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import {
  ERROR_CODES,
  PROTOCOL_FEATURES,
  compareVersions,
  type ErrorCode,
} from "@nylorun/core/compatibility";
import {
  AdminClient,
  OPERATOR_KEYS_FEATURE,
  resolveAdminConnection,
  tenantHostRoot,
  type AdminConnectionOptions,
  type AdminKeys,
} from "./client.js";
import {
  PROJECT_PRINCIPAL_ID,
  deriveStudioToken,
  deriveTenantKey,
} from "./derived-credentials.js";
import { AdminError } from "./errors.js";

export { ERROR_CODES, PROTOCOL_FEATURES, compareVersions };
export type { ErrorCode };
export { AdminError };
export { PROJECT_PRINCIPAL_ID, deriveStudioToken, deriveTenantKey, tenantHostRoot };
export { mintStudioLoginToken } from "./studio-login.js";
export { OPERATOR_KEYS_FEATURE };

export interface Admin {
  /** The Host's Tenant API URL. */
  readonly url: string;
  /** Where Admin API requests go: the operator listener, or `url` on a single-port Host. */
  readonly adminUrl: string;
  readonly source: "options" | "environment" | "local-host";
  /** The Host's status, with the one Tenant it serves (`status.tenant`). */
  status(): Promise<AdminStatus>;
  /**
   * The Tenant's operator keys (Host feature `operator-keys`): revocable application keys by
   * name. `keys.put("babai")` creates or rotates a key and returns it once.
   */
  readonly keys: AdminKeys;
  /**
   * The key of a derived principal on the Host's Tenant, from this client's admin key. The
   * Host registers the principals it is configured with (`NYLORUN_DERIVED_PRINCIPALS`, default
   * `project`) when it creates its Tenant.
   */
  deriveTenantKey(tenantId: string, principalId: string): string;
}

/**
 * Resolution: explicit `url` + `key` → `NYLORUN_ADMIN_URL` + `NYLORUN_ADMIN_KEY` → the local
 * Host's settings in its Host root (`home`, `NYLORUN_HOME`, or the Tenant named by `tenant`,
 * `NYLORUN_TENANT` or the Project link under `cwd`: `~/.nylorun/tenants/<tenant>/`).
 */
export function createAdmin(options?: AdminConnectionOptions): Admin {
  return new AdminClient(resolveAdminConnection(options));
}

export type {
  AdminConnectionOptions,
  AdminKeys,
  AdminStatus,
  HostTenant,
  OperatorKey,
  PutOperatorKeyResponse,
  TenantEnvelope,
};
