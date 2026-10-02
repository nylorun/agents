/**
 * What the gates service opens of the Tenant: its vault's host model, and nothing else. The
 * full Tenant (`TenantRuntime.open`) migrates its database, creates its key file and starts
 * its services; the gate does none of that. The database holds one Tenant (tenancy.md §1):
 * the gate reads which one from it, refuses a database whose Tenant schema isn't at this
 * build's version (the Runtime migrates it when it opens the Tenant) and never creates a vault
 * key. The vault is opened once and kept.
 */
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelFailureOutcome } from "@nylorun/core/define";
import { isTenantId } from "@nylorun/core/compatibility";
import { failure } from "../model/classify.js";
import type { PostgresClient } from "../store/postgres/connect.js";
import { POSTGRES_SCHEMA_VERSION } from "../store/postgres/migrations/index.js";
import {
  readTenantEnvelope,
  readTenantSchemaVersion,
} from "../store/postgres/tenant.js";
import { createPostgresSessionStore } from "../store/postgres/store.js";
import { tenantPaths } from "../tenant/paths.js";
import { readVaultKek } from "../vault/kek.js";
import { HostModelVault } from "../vault/host-model.js";
import type { HostModelSecret } from "../vault/service.js";
import type { SessionStore } from "../store/types.js";

/** The Tenant, as a model call needs it. */
export interface TenantVault {
  readonly tenantId: string;
  /** The Tenant's store, for the usage ledger (P1.3). */
  readonly store: SessionStore;
  /** The Tenant's home: secrets found there are redacted from failure messages. */
  readonly root: string;
  readHostModel(): Promise<HostModelSecret | undefined>;
  /** Writes back a credential pi-ai refreshed (OAuth). */
  writeHostCredential(credential: Credential): Promise<void>;
}

export interface TenantVaults {
  /**
   * Opens the Tenant's vault, or rejects with a `GateRefusal`. `tenantId`, when the caller
   * names one, must be the database's Tenant.
   */
  open(tenantId?: string): Promise<TenantVault>;
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
  /** The Host root; the gate reads `tenant/vault-kek` and `tenant/home` under it. */
  readonly hostRoot: string;
}

export function createTenantVaults(options: TenantVaultsOptions): TenantVaults {
  const { sql, hostRoot } = options;
  let opened: TenantVault | undefined;

  function build(tenantId: string): TenantVault {
    const paths = tenantPaths(hostRoot);
    const store = createPostgresSessionStore({ sql, tenantId });
    let kek: Buffer | undefined;
    const vault = new HostModelVault({
      store,
      kek: () => {
        kek ??= readVaultKek({ vaultKekPath: paths.kek });
        if (!kek)
          throw new GateRefusal(
            failure(
              "auth",
              "The Tenant's vault key is missing on the gateway container; check that it mounts the Host's tenant directory",
              false,
            ),
          );
        return kek;
      },
    });
    return {
      tenantId,
      store,
      root: paths.home,
      readHostModel: () => vault.readHostModel(),
      writeHostCredential: (credential) => vault.updateHostCredential(credential),
    };
  }

  /** The database's Tenant, once its schema is at this build's version. */
  async function load(): Promise<TenantVault> {
    const version = await readTenantSchemaVersion(sql);
    if (version === undefined || version === 0)
      throw new GateRefusal(
        failure("transient", "The Tenant's database is not migrated yet; the Runtime does that when it starts", true),
      );
    if (version !== POSTGRES_SCHEMA_VERSION)
      throw new GateRefusal(
        failure(
          "transient",
          `The Tenant is at schema version ${version}; the gateway serves version ${POSTGRES_SCHEMA_VERSION}`,
          version < POSTGRES_SCHEMA_VERSION,
        ),
      );
    const envelope = await readTenantEnvelope(sql).catch(() => undefined);
    if (!envelope)
      throw new GateRefusal(
        failure("transient", "The database holds no Tenant yet; the Runtime creates it when it starts", true),
      );
    return build(envelope.id);
  }

  return {
    async open(tenantId) {
      if (tenantId !== undefined && !isTenantId(tenantId))
        throw new GateRefusal(failure("invalid_request", "Not a Tenant id", false));
      opened ??= await load();
      if (tenantId !== undefined && tenantId !== opened.tenantId)
        throw new GateRefusal(
          failure("invalid_request", `Tenant ${tenantId} is not this installation's Tenant`, false),
        );
      return opened;
    },
  };
}
