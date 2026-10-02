/**
 * What the gates service opens of a Tenant: its vault's host model, and nothing else. The
 * full Tenant (`TenantRuntime.open`) migrates its schema, creates its key file and starts its
 * services; the gate does none of that. It refuses a Tenant whose schema isn't at this build's
 * version (the Runtime migrates it when it opens the Tenant), and never creates a vault key.
 *
 * Handles are cached per Tenant, at most `max`, least recently used first out.
 */
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelFailureOutcome } from "@nylorun/core/define";
import { isTenantId } from "@nylorun/core/compatibility";
import { failure } from "../model/classify.js";
import type { PostgresClient } from "../store/postgres/connect.js";
import {
  POSTGRES_SCHEMA_VERSION,
  readSchemaVersion,
} from "../store/postgres/migrations/index.js";
import { tenantSchemaName } from "../store/postgres/names.js";
import { createPostgresSessionStore } from "../store/postgres/store.js";
import { tenantPaths } from "../tenant/paths.js";
import { readVaultKek } from "../vault/kek.js";
import { VaultService, type HostModelSecret } from "../vault/service.js";

/** One Tenant, as a model call needs it. */
export interface TenantVault {
  /** The Tenant's home: secrets found there are redacted from failure messages. */
  readonly root: string;
  readHostModel(): Promise<HostModelSecret | undefined>;
  /** Writes back a credential pi-ai refreshed (OAuth). */
  writeHostCredential(credential: Credential): Promise<void>;
}

export interface TenantVaults {
  /** Opens a Tenant's vault, or rejects with a `GateRefusal`. */
  open(tenantId: string): Promise<TenantVault>;
}

/** A call the gate refuses before the provider is called; it answers with `outcome`. */
export class GateRefusal extends Error {
  constructor(readonly outcome: ModelFailureOutcome) {
    super(outcome.message);
    this.name = "GateRefusal";
  }
}

export interface TenantVaultsOptions {
  readonly sql: PostgresClient;
  /** The Host root; the gate reads `tenants/<id>/vault-kek` and `tenants/<id>/home` under it. */
  readonly hostRoot: string;
  /** Most Tenants kept open. Default 256. */
  readonly max?: number;
}

export function createTenantVaults(options: TenantVaultsOptions): TenantVaults {
  const { sql, hostRoot } = options;
  const max = options.max ?? 256;
  const open = new Map<string, TenantVault>();

  function build(tenantId: string): TenantVault {
    const paths = tenantPaths(hostRoot, tenantId);
    let kek: Buffer | undefined;
    const vault = new VaultService({
      store: createPostgresSessionStore({ sql, tenantId }),
      kek: () => {
        kek ??= readVaultKek({ vaultKekPath: paths.kek });
        if (!kek)
          throw new GateRefusal(
            failure(
              "auth",
              "The Tenant's vault key is missing on the gateway container; check that it mounts the Host's tenants directory",
              false,
            ),
          );
        return kek;
      },
      fetch: globalThis.fetch,
    });
    return {
      root: paths.home,
      readHostModel: () => vault.readHostModel(),
      writeHostCredential: (credential) => vault.updateHostCredential(credential),
    };
  }

  return {
    async open(tenantId) {
      if (!isTenantId(tenantId))
        throw new GateRefusal(failure("invalid_request", "Not a Tenant id", false));
      const cached = open.get(tenantId);
      if (cached) {
        open.delete(tenantId);
        open.set(tenantId, cached);
        return cached;
      }
      const version = await readSchemaVersion(sql, tenantSchemaName(tenantId));
      if (version === undefined)
        throw new GateRefusal(failure("invalid_request", `Tenant ${tenantId} does not exist`, false));
      if (version !== POSTGRES_SCHEMA_VERSION)
        throw new GateRefusal(
          failure(
            "transient",
            `Tenant ${tenantId} is at schema version ${version}; the gateway serves version ${POSTGRES_SCHEMA_VERSION}`,
            version < POSTGRES_SCHEMA_VERSION,
          ),
        );
      const vault = build(tenantId);
      open.set(tenantId, vault);
      if (open.size > max) open.delete(open.keys().next().value!);
      return vault;
    },
  };
}
