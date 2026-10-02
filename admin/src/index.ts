import type { AdminStatus, HostTenant, TenantEnvelope } from "@nylorun/core/contracts";
import type { AdminTenant, AdminTenantStatus } from "./legacy-tenants.js";
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
export { mintStudioLoginToken } from "./studio-login.js";

export interface Admin {
  /** The Host's Tenant API URL. */
  readonly url: string;
  /** Where Admin API requests go: the operator listener, or `url` on a single-port Host. */
  readonly adminUrl: string;
  readonly source: "options" | "environment" | "local-host";
  /** The Host's status, with the one Tenant it serves (`status.tenant`). */
  status(): Promise<AdminStatus>;
  /** @deprecated A protocol 5 Host serves one Tenant and has no Tenant routes (404). */
  listTenants(): Promise<AdminTenant[]>;
  /** @deprecated A protocol 5 Host serves one Tenant and has no Tenant routes (404). */
  getTenant(id: string): Promise<AdminTenantStatus>;
  /** @deprecated A protocol 5 Host serves one Tenant and has no Tenant routes (404). */
  deleteTenant(
    id: string,
    options?: { activeWork?: "refuse" | "drain" | "cancel" },
  ): Promise<void>;
  /**
   * Creates a Tenant. `principals` names derived principals (e.g. `["babai"]`): their keys
   * come from `deriveTenantKey`, so their clients store none. Needs Host feature
   * `derived-principals`.
   *
   * @deprecated A protocol 5 Host creates its one Tenant itself on first start (with the
   * derived principals it is configured with) and has no Tenant routes (404).
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

export type { AdminStatus, AdminTenant, AdminTenantStatus, HostTenant, TenantEnvelope };
