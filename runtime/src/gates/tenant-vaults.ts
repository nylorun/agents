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
import { database } from "../store/postgres/db.js";
import { expectedSchemaVersion, readSchemaVersion } from "../store/postgres/migrate.js";
import { readTenantEnvelope } from "../store/postgres/tenant.js";
import { createPostgresSessionStore } from "../store/postgres/store.js";
import { tenantPaths } from "../tenant/paths.js";
import { readVaultKek } from "../vault/kek.js";
import { HostModelVault } from "../vault/host-model.js";
import { VaultService, type AuthorizeResult, type HostModelSecret } from "../vault/service.js";
import type { SessionStore } from "../store/types.js";
import type { Session } from "../tenant/context.js";
import { inProcessKeys, type Keys } from "../keys/keys.js";
import { SigningKeys } from "../tenant/signing-keys.js";

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
  /** A session, for the remote MCP servers its pinned manifest declares (F4.1). */
  session(sessionId: string): Promise<Session | undefined>;
  /**
   * The vault authorization of one request to a session's remote MCP server: its credential
   * from the session's attached vaults, refreshed when due (F4.1).
   */
  authorizeMcp(sessionId: string, request: { url: string; serverName: string }): Promise<AuthorizeResult>;
  /** Vault writes and token signing with the Tenant's vault key (the keys service, F4.2). */
  keys(): Keys;
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
  /** The Host root; the gate reads `keys/vault-kek` and `tenant/home` under it. */
  readonly hostRoot: string;
}

export function createTenantVaults(options: TenantVaultsOptions): TenantVaults {
  const { sql, hostRoot } = options;
  let opened: TenantVault | undefined;

  function build(tenantId: string): TenantVault {
    const paths = tenantPaths(hostRoot);
    const store = createPostgresSessionStore({ sql, tenantId });
    let kek: Buffer | undefined;
    const readKek = () => {
      kek ??= readVaultKek({ vaultKekPath: paths.kek });
      if (!kek)
        throw new GateRefusal(
          failure(
            "auth",
            "The Tenant's vault key is missing on the gateway container; check that it mounts the Host's keys directory, which `nylorun start` creates",
            false,
          ),
        );
      return kek;
    };
    const vault = new HostModelVault({ store, kek: readKek });
    const credentials = new VaultService({ store, kek: readKek, fetch: globalThis.fetch });
    const keys = inProcessKeys({
      store,
      vault: credentials,
      signingKeys: new SigningKeys({ tenantId, kek: readKek }),
      kek: readKek,
    });
    const session = (sessionId: string) =>
      store.tx((t) => t.get<Session>("sessions", sessionId));
    return {
      tenantId,
      store,
      root: paths.home,
      readHostModel: () => vault.readHostModel(),
      writeHostCredential: (credential) => vault.updateHostCredential(credential),
      session,
      authorizeMcp: (sessionId, request) =>
        authorizeSessionMcp(credentials, session, sessionId, request),
      keys: () => keys,
    };
  }

  /** The database's Tenant, once its schema is at this build's version. */
  async function load(): Promise<TenantVault> {
    const version = await readSchemaVersion(database(sql));
    const expected = expectedSchemaVersion();
    if (version === undefined || version === 0)
      throw new GateRefusal(
        failure("transient", "The Tenant's database is not migrated yet; the Runtime does that when it starts", true),
      );
    if (version !== expected)
      throw new GateRefusal(
        failure(
          "transient",
          `The Tenant is at schema version ${version}; the gateway serves version ${expected}`,
          version < expected,
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

/**
 * A request to a session's remote MCP server, authorized from the session's attached vaults:
 * what the loop did in its own process before F4.1 (`tenant/effects.ts` `authorize`).
 */
export async function authorizeSessionMcp(
  credentials: VaultService,
  session: (sessionId: string) => Promise<Session | undefined>,
  sessionId: string,
  request: { url: string; serverName: string },
): Promise<AuthorizeResult> {
  const found = await session(sessionId);
  if (!found) throw new Error(`Session ${sessionId} not found`);
  return credentials.authorize({
    sessionId,
    vaultIds: found.vaultIds ?? [],
    credentialSelections: found.credentialSelections ?? [],
    url: request.url,
    serverName: request.serverName,
  });
}
