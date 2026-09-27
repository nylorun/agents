import type { TenantEnvelope } from "@nylorun/core/contracts";
import { isTenantId } from "@nylorun/core/compatibility";
import { TENANT_SCHEMA_VERSION } from "./schema.js";
import { quarantine } from "./quarantine.js";
import { parseEnvelope } from "./envelope.js";
import type {
  BootstrapPrincipal,
  Logger,
  OpenTenantRuntime,
  TenantConfig,
  TenantHandle,
  TenantStore,
} from "./types.js";

export interface MemoryTenantStoreOptions {
  openRuntime: OpenTenantRuntime;
  configFor: (tenantId: string) => TenantConfig;
  logger?: Logger;
  /** Schema version recorded for new tenants (default TENANT_SCHEMA_VERSION). */
  schemaVersion?: number;
}

interface MemoryRecord {
  envelope: TenantEnvelope;
  bootstrap: BootstrapPrincipal;
  handle?: TenantHandle;
  schemaVersion: number;
  trashed?: boolean;
}

/**
 * In-memory TenantStore for tests. No filesystem; openRuntime is still injected
 * so conformance can exercise the same module path as the FS adapter.
 */
export function createMemoryTenantStore(
  options: MemoryTenantStoreOptions,
): TenantStore & {
  /** Test helper: insert a raw record without opening. */
  seed(envelope: TenantEnvelope, bootstrap: BootstrapPrincipal): void;
  /** Test helper: current live ids. */
  ids(): string[];
} {
  const records = new Map<string, MemoryRecord>();
  const schemaVersion = options.schemaVersion ?? TENANT_SCHEMA_VERSION;

  const store: TenantStore & {
    seed(envelope: TenantEnvelope, bootstrap: BootstrapPrincipal): void;
    ids(): string[];
  } = {
    seed(envelope, bootstrap) {
      const env = parseEnvelope(envelope, envelope.id);
      records.set(env.id, {
        envelope: env,
        bootstrap: { ...bootstrap },
        schemaVersion: env.schemaVersion,
      });
    },

    ids() {
      return [...records.keys()].filter((id) => !records.get(id)?.trashed);
    },

    async enumerate() {
      return [...records.entries()]
        .filter(([, r]) => !r.trashed)
        .map(([id]) => id)
        .filter(isTenantId);
    },

    async readEnvelope(id) {
      const record = records.get(id);
      if (!record || record.trashed) {
        throw quarantine("envelope-invalid", "tenant envelope not found", {
          tenantId: id,
        });
      }
      return parseEnvelope(record.envelope, id);
    },

    async create(envelope, bootstrap) {
      const env = parseEnvelope(envelope, envelope.id);
      const existing = records.get(env.id);
      if (existing && !existing.trashed) return "exists";
      records.set(env.id, {
        envelope: env,
        bootstrap: { ...bootstrap },
        schemaVersion: env.schemaVersion || schemaVersion,
      });
      return "created";
    },

    async bootstrapMatches(id, bootstrap) {
      const record = records.get(id);
      if (!record || record.trashed) return false;
      return (
        record.bootstrap.principalId === bootstrap.principalId &&
        record.bootstrap.credentialHash === bootstrap.credentialHash &&
        record.bootstrap.idempotencyKey === bootstrap.idempotencyKey &&
        record.bootstrap.studioCredentialHash === bootstrap.studioCredentialHash
      );
    },

    async open(id) {
      const record = records.get(id);
      if (!record || record.trashed) {
        throw quarantine("open-failed", `Tenant ${id} not found`, {
          tenantId: id,
        });
      }
      if (record.schemaVersion > TENANT_SCHEMA_VERSION) {
        throw quarantine(
          "schema-too-new",
          `Tenant schema version ${record.schemaVersion} is newer than Host ${TENANT_SCHEMA_VERSION}`,
          { tenantId: id },
        );
      }
      const config = options.configFor(id);
      const opened = await options.openRuntime({
        ...config,
        tenantId: id,
      });
      const handle: TenantHandle = {
        ...opened,
        envelope: record.envelope,
        handle: opened.handle.bind(opened),
        summary: opened.summary.bind(opened),
        drain: opened.drain.bind(opened),
        close: opened.close.bind(opened),
      };
      record.handle = handle;
      return handle;
    },

    async trash(id, _now) {
      const record = records.get(id);
      if (!record) return;
      if (record.handle) {
        await record.handle.close().catch(() => undefined);
      }
      record.trashed = true;
      record.handle = undefined;
    },

    async removePartial(id) {
      records.delete(id);
    },
  };

  return store;
}
