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
import { deriveStudioToken } from "./derived-credentials.js";
import { AdminError } from "./errors.js";

export { ERROR_CODES, PROTOCOL_FEATURES, compareVersions };
export type { ErrorCode };
export { AdminError };
export { deriveStudioToken };

export interface Admin {
  readonly url: string;
  readonly source: "options" | "environment" | "local-host";
  status(): Promise<AdminStatus>;
  listTenants(): Promise<AdminTenant[]>;
  getTenant(id: string): Promise<AdminTenantStatus>;
  deleteTenant(
    id: string,
    options?: { activeWork?: "refuse" | "drain" | "cancel" },
  ): Promise<void>;
  createTenant(options: {
    name: string;
  }): Promise<{ tenant: TenantEnvelope; applicationKey: string }>;
}

export function createAdmin(options?: {
  url?: string;
  key?: string;
  home?: string;
}): Admin {
  return new AdminClient(resolveAdminConnection(options));
}

export type { AdminStatus, AdminTenant, AdminTenantStatus, TenantEnvelope };
