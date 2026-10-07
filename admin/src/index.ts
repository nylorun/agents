import type {
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
  resolveAdminConnection,
  tenantHostRoot,
  type AdminConnectionOptions,
  type AdminSource,
} from "./client.js";
import { deriveStudioToken } from "./derived-credentials.js";
import { AdminError } from "./errors.js";

export { ERROR_CODES, PROTOCOL_FEATURES, compareVersions };
export type { ErrorCode };
export { AdminError };
export { deriveStudioToken, tenantHostRoot };
export { mintStudioLoginToken } from "./studio-login.js";
export {
  ManagementClient,
  createManagementClient,
  type ManagementClientOptions,
  type ManagementKeys,
  type ManagementMcp,
  type ManagementModels,
  type ManagementSettings,
  type ManagementSigningKeys,
  type ManagementTenant,
  type ManagementVaults,
} from "./management.js";

/**
 * The Management API client for the installation (`/v1/tenant/*`): `tenant`, `keys`
 * (application keys), `models`, `vaults`, `mcp`, `signingKeys` and `settings`, with a management key.
 * `source` says where the connection came from.
 */
export type Admin = AdminClient;

/**
 * Resolution: explicit `url` + `key` (a management key) → `NYLORUN_RUNTIME_URL` +
 * `NYLORUN_MANAGEMENT_KEY` → the local Host: the URL from `host.json` in its Host root
 * (`home`, `NYLORUN_HOME`, or the Tenant named by `tenant`, `NYLORUN_TENANT` or the Project link
 * under `cwd`: `~/.nylorun/tenants/<tenant>/`), and the management key from the linked
 * Project's `.nylorun/credentials.json`, else the Host root's `project-credentials.json`, else
 * its `cli-credentials.json`. The first request checks the Host's `/health` first.
 */
export function createAdmin(options?: AdminConnectionOptions): Admin {
  return new AdminClient(resolveAdminConnection(options));
}

export type {
  AdminConnectionOptions,
  AdminSource,
  HostTenant,
  OperatorKey,
  PutOperatorKeyResponse,
  TenantEnvelope,
};
