/**
 * An in-memory Tenant store for tests: each Tenant is a `MemoryStoreData` (its Session
 * Store's data) and an envelope. It behaves like the Postgres store (`store-pg.ts`): the
 * Tenant directory under the Host root, when one is given, is created with the Tenant and
 * removed with it, and `open` hands the Tenant Runtime a fresh Session Store on the Tenant's
 * data. Not a supported profile.
 */
import { mkdirSync, rmSync } from "node:fs";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { isTenantId } from "@nylorun/core/compatibility";
import {
  MEMORY_SCHEMA_VERSION,
  MemorySessionStore,
  MemoryStoreData,
} from "../store/memory.js";
import type { SessionStore } from "../store/types.js";
import { quarantine } from "./quarantine.js";
import { parseEnvelope } from "./envelope.js";
import { tenantPaths } from "./paths.js";
import { bootstrapPrincipal, bootstrapPrincipalMatches } from "./principals.js";
import {
  TenantNotFoundError,
  type BootstrapPrincipal,
  type Logger,
  type OpenTenantRuntime,
  type TenantConfig,
  type TenantStore,
} from "./types.js";

export interface MemoryTenantStoreOptions {
  /** When set, each Tenant's directory under this Host root lives as long as the Tenant. */
  hostRoot?: string;
  openRuntime: OpenTenantRuntime;
  configFor: (tenantId: string) => TenantConfig;
  logger?: Logger;
}

interface MemoryRecord {
  envelope: TenantEnvelope;
  data: MemoryStoreData;
}

export type MemoryTenantStore = TenantStore & {
  /** Test helper: current Tenant ids. */
  ids(): string[];
  /** Test helper: a Session Store on a Tenant's data, as another process would open it. */
  sessionStore(id: string): SessionStore;
};

export function createMemoryTenantStore(
  options: MemoryTenantStoreOptions,
): MemoryTenantStore {
  const records = new Map<string, MemoryRecord>();

  function sessionStore(id: string, data: MemoryStoreData): SessionStore {
    return new MemorySessionStore(
      {
        tenantId: id,
        onError: (error) =>
          options.logger?.error("post-commit step failed", {
            message: error instanceof Error ? error.message : String(error),
          }),
      },
      data,
    );
  }

  function makeDirectory(id: string): void {
    if (!options.hostRoot) return;
    const p = tenantPaths(options.hostRoot, id);
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    for (const dir of [p.home, p.tmp, p.sandboxes, p.pluginData, p.logs])
      mkdirSync(dir, { recursive: true });
  }

  function removeDirectory(id: string): void {
    if (options.hostRoot)
      rmSync(tenantPaths(options.hostRoot, id).root, {
        recursive: true,
        force: true,
      });
  }

  async function withStore<T>(
    id: string,
    data: MemoryStoreData,
    fn: (store: SessionStore) => Promise<T>,
  ): Promise<T> {
    const store = sessionStore(id, data);
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  }

  return {
    ids() {
      return [...records.keys()];
    },

    sessionStore(id) {
      const record = records.get(id);
      if (!record) throw new TenantNotFoundError(id);
      return sessionStore(id, record.data);
    },

    async enumerate() {
      return [...records.keys()].filter(isTenantId).sort();
    },

    async readEnvelope(id) {
      const record = records.get(id);
      if (!record) throw new TenantNotFoundError(id);
      return parseEnvelope(record.envelope, id);
    },

    async create(envelope, bootstrap: BootstrapPrincipal) {
      const parsed = parseEnvelope(
        { ...envelope, schemaVersion: MEMORY_SCHEMA_VERSION },
        envelope.id,
      );
      if (records.has(parsed.id)) return "exists";
      makeDirectory(parsed.id);
      const data = new MemoryStoreData();
      await withStore(parsed.id, data, (store) =>
        store.tx((t) => bootstrapPrincipal(t, bootstrap)),
      );
      records.set(parsed.id, { envelope: parsed, data });
      return "created";
    },

    async bootstrapMatches(id, bootstrap) {
      const record = records.get(id);
      if (!record) return false;
      return withStore(id, record.data, (store) =>
        store.tx((t) => bootstrapPrincipalMatches(t, bootstrap)),
      );
    },

    async open(id) {
      const record = records.get(id);
      if (!record) throw new TenantNotFoundError(id);
      if (record.envelope.schemaVersion > MEMORY_SCHEMA_VERSION)
        throw quarantine(
          "schema-too-new",
          `Tenant schema version ${record.envelope.schemaVersion} is newer than this Runtime's ${MEMORY_SCHEMA_VERSION}`,
          { tenantId: id },
        );
      makeDirectory(id);
      const store = sessionStore(id, record.data);
      try {
        return await options.openRuntime(
          { ...options.configFor(id), tenantId: id },
          { store, envelope: record.envelope },
        );
      } catch (error) {
        await store.close().catch(() => undefined);
        throw error;
      }
    },

    async trash(id) {
      records.delete(id);
      removeDirectory(id);
    },

    async removePartial(id) {
      if (records.has(id)) return;
      removeDirectory(id);
    },
  };
}
