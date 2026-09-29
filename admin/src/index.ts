import type {
  AdminStatus,
  AdminTenant,
  AdminTenantStatus,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import {
  ERROR_CODES,
  PROTOCOL_FEATURES,
  compareVersions,
  type ErrorCode,
} from "@nylorun/core/compatibility";
import { AdminClient, resolveAdminConnection } from "./client.js";
import {
  PROJECT_PRINCIPAL_ID,
  deriveStudioToken,
  deriveTenantKey,
} from "./derived-credentials.js";
import { AdminError } from "./errors.js";

export { ERROR_CODES, PROTOCOL_FEATURES, compareVersions };
export type { ErrorCode };
export { AdminError };
export { PROJECT_PRINCIPAL_ID, deriveStudioToken, deriveTenantKey };

export interface Admin {
  /** The Host's Tenant API URL. */
  readonly url: string;
  /** Where Admin API requests go: the operator listener, or `url` on a single-port Host. */
  readonly adminUrl: string;
  readonly source: "options" | "environment" | "local-host";
  status(): Promise<AdminStatus>;
  listTenants(): Promise<AdminTenant[]>;
  getTenant(id: string): Promise<AdminTenantStatus>;
  deleteTenant(
    id: string,
    options?: { activeWork?: "refuse" | "drain" | "cancel" },
  ): Promise<void>;
  /**
   * Creates a Tenant. `principals` names derived principals (e.g. `["babai"]`): their keys
   * come from `deriveTenantKey`, so their clients store none. Needs Host feature
   * `derived-principals`.
   */
  createTenant(options: {
    name: string;
    principals?: readonly string[];
  }): Promise<{ tenant: TenantEnvelope; applicationKey: string }>;
  /** The key of a derived principal on a Tenant, from this client's admin key. */
  deriveTenantKey(tenantId: string, principalId: string): string;
}

export function createAdmin(options?: {
  url?: string;
  key?: string;
  home?: string;
}): Admin {
  return new AdminClient(resolveAdminConnection(options));
}

export type { AdminStatus, AdminTenant, AdminTenantStatus, TenantEnvelope };
