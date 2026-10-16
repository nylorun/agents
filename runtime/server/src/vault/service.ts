/**
 * The Runtime vault (docs/design/runtime/vault.md, D56): one vault per Environment, created and
 * deleted with it, holding the Environment's secrets; and the host vault, which holds the model
 * credential. Storage is the async Session Store (`store/types.ts`); this module holds no SQL.
 *
 * ## Public surface
 *
 * ```ts
 * new VaultService({ store: SessionStore, kek: () => Buffer })
 *
 * // An Environment's vault, in the caller's transaction (`tenant/environments.ts`).
 * createEnvironmentVault(t: Tx, environmentId: string, actor: string, id?: string): Promise<string>
 * deleteEnvironmentVault(t: Tx, environmentId: string, actor: string): Promise<void>
 *
 * // A fork's secrets (Q15): `Keys` seals the copies with the vault key in its own transaction,
 * // before the fork's; the fork's transaction inserts them, so the process that forks never
 * // holds the key.
 * sealEnvironmentSecretCopies(from, vaultId, slots | null): Promise<SealedSecretCopies>
 * insertEnvironmentSecretCopies(t: Tx, vaultId, from, actor, sealed): Promise<{ copied; dropped }>
 *
 * // Its secrets (`/v1/agents/{id}/secrets`): each opens its own transaction and writes its
 * // audit rows in it. A put needs the vault key, so callers reach it through `Keys`.
 * putEnvironmentSecret(environmentId, name, body: PutAgentSecretRequest, actor): Promise<AgentSecretView>
 * listEnvironmentSecrets(environmentId): Promise<AgentSecretView[]>
 * getEnvironmentSecret(environmentId, name): Promise<AgentSecretView>
 * deleteEnvironmentSecret(environmentId, name, actor): Promise<{ id: string }>
 *
 * // The shell's variables of a session's sandbox, in the caller's transaction (R2c).
 * environmentVariables(t: Tx, environmentId: string | undefined): Promise<Record<string, string>>
 *
 * // Use: opens its own transactions; never call it inside one. `sessionCredentials`
 * // (`vault/sources.ts`) calls it for a session's MCP servers and HTTP tools; a tool preview
 * // (R2b C12, `mcp/preview.ts`) for no session; egress-gate releases shell secrets.
 * authorize(input: { sessionId?; environmentId?; url }): Promise<AuthorizeResult>
 * releaseEnvironmentSecret(input: { environmentId; host }): Promise<…>
 *
 * // Coverage: what `authorize` would decide for each URL a manifest names, in one transaction,
 * // with no secret read and no audit row.
 * coverage(manifest: AgentManifest | WorkflowManifest, request: CredentialCoverageRequest): Promise<CredentialCoverage>
 *
 * // Host model credential: each opens its own transaction.
 * getHostModel(): Promise<HostModelView>
 * listHostProviders(): Promise<{ providers: HostModelProviderInfo[] }>
 * putHostModel(body: PutHostModelRequest): Promise<HostModelView>
 * selectHostModel(body: SelectHostModelRequest): Promise<HostModelView>
 * ```
 *
 * Reading the host model's secret and writing back a refreshed one are `HostModelVault`'s
 * (`vault/host-model.ts`), which only the Model Gate uses: this service seals the host model's
 * credential but never reads it back.
 *
 * ## One credential per host and per URL
 *
 * A secret write is refused (`409 credential_conflict`) when another `environment_secret` of the
 * vault is bound to one of its hosts, or another `bearer` or `headers` credential to its URL, so
 * a release or a tool call never has two to choose from. Names are unique per vault: for the
 * shell kinds the name is the variable, so no variable is set twice.
 *
 * ## Transactions and I/O
 *
 * - No network I/O runs inside a transaction. The KEK getter may touch the
 *   filesystem (it creates the key file on first use), so methods that
 *   encrypt or decrypt resolve the KEK before opening their transaction and
 *   do only in-memory crypto inside it.
 * - `authorize` reads the Environment's vault and the credential bound to the URL (ciphertext
 *   only) in one transaction. Decryption happens after it commits, so the plaintext never
 *   enters a transaction. The `use`/`approved` audit row is written in a final transaction
 *   before the header is returned: if that write fails, `authorize` rejects and no header
 *   leaves the vault, so every approved use has an audit row. Unreadable ciphertext is audited
 *   in its own transaction before the refusal is returned.
 *
 * ## Credentials (R2b C2)
 *
 * A tool credential is bound to the URL a manifest names and sends a `bearer` token or a
 * `headers` map, both sealed. Its `via` (where requests go, such as a gateway) and `identity`
 * (the header that names the session owner) are not secret: they live unsealed in the binding,
 * beside the URL and the header names. The seal's AAD binds the vault, credential id, type and
 * URL only, and matching is by URL only, so `via` never decides which credential is chosen.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ENVIRONMENT_SECRET_DEFAULT_INJECT,
  ENVIRONMENT_SECRET_SENTINEL,
  environmentSecretNameError,
  renderInjectFormat,
} from "@nylorun/core/contracts";
import type {
  CoverageCredential,
  CredentialCoverage,
  CredentialCoverageEntry,
  CredentialCoverageRequest,
  CredentialIdentity,
  EnvironmentSecretInject,
  AgentSecretView,
  HostModelProviderInfo,
  HostModelView,
  PutAgentSecretRequest,
  PutHostModelRequest,
  CustomModelSettings,
  ModelInput,
  SelectHostModelRequest,
} from "@nylorun/core/contracts";
import type { AgentManifest, WorkflowManifest } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import type {
  SessionStore,
  Tx,
  VaultCredentialRow,
  VaultRow,
} from "../store/types.js";
import { decryptSecret, encryptSecret, VaultCryptoError } from "./crypto.js";
import { VaultError } from "./error.js";
import { credentialNeeds, type CredentialNeed } from "./coverage.js";
import { checkCredentialHeaders } from "./headers.js";
import { hostModelCatalog, inputsOfHostModel } from "../model/catalog.js";
import { inputsError } from "../model/capabilities.js";
import { readAddedInputs } from "../tenant/model-setting.js";
import { normalizeVaultUrl } from "./url.js";

export const HOST_VAULT_ID = "host";
const HOST_MODEL_ID = "host-model";

export type HostModelSecret = {
  provider: string;
  model: string;
  baseUrl?: string;
  /** A custom endpoint's window, output limit, reasoning, inputs and pi-ai compat (Model Calls §7). */
  settings?: CustomModelSettings;
  /** The inputs the operator added to catalog models, by `<provider>/<model>` (protocol 12). */
  addedInputs?: Readonly<Record<string, readonly ModelInput[]>>;
  authType: "api_key" | "oauth";
  credential: {
    type: "api_key" | "oauth";
    key?: string;
    env?: Record<string, string>;
    refresh?: string;
    access?: string;
    expires?: number;
    [key: string]: unknown;
  };
};

type SecretPayload = {
  /** A `bearer` credential's token. */
  token?: string;
  /** An `environment_secret`'s value (R2c). */
  value?: string;
  /** A `headers` credential's map, names lower-cased. */
  headers?: Record<string, string>;
};

type UserCredentialRow = VaultCredentialRow & {
  type: "bearer" | "headers" | "environment_secret" | "environment_variable";
};

/**
 * A fork's secrets sealed for its new vault (`sealEnvironmentSecretCopies`): each copy's
 * ciphertext, base64 so it crosses the keys service's JSON, and what about it is not secret.
 */
export interface SealedSecretCopies {
  readonly copies: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: UserCredentialRow["type"];
    readonly bindingJson: string;
    readonly expiresAt: string | null;
    readonly kekId: string;
    readonly nonce: string;
    readonly ciphertext: string;
    readonly wrappedDek: string;
  }[];
  /** Names left behind: no slot of the fork declares them, or their slot cannot take the value. */
  readonly dropped: readonly string[];
}

/** A user credential's `bindingJson`: everything about it that is not secret. */
type CredentialBinding = {
  /** A `bearer` or `headers` credential's server URL; absent for the environment kinds. */
  url?: string;
  /** An `environment_secret`'s variable, hosts and header (R2c); sealed into its AAD. */
  secretName?: string;
  allowedHosts?: string[];
  inject?: EnvironmentSecretInject;
  /** An `environment_variable`'s name and plain value (R2c): not a secret. */
  variableName?: string;
  variableValue?: string;
  via?: string;
  identity?: CredentialIdentity;
  /** A `headers` credential's names, lower-cased. */
  headerNames?: string[];
};

export type AuthorizeResult =
  | {
      status: "unauthenticated";
      url: string;
      headers: Record<string, string>;
    }
  | {
      status: "authorized";
      url: string;
      /** The vault credential's headers: `authorization` for a `bearer`, a `headers` map's. */
      headers: Record<string, string>;
      /** Where the request goes instead of `url` (a gateway), when the credential has one. */
      via?: string;
      /** The header that names the session owner; `sessionCredentials` adds it. */
      identity?: CredentialIdentity;
    }
  | {
      status: "refused";
      url: string;
      credentialIds: string[];
      reason: string;
    };

type AuditEntry = {
  actor: string;
  action: string;
  outcome: string;
  vaultId?: string;
  credentialId?: string;
  sessionId?: string;
  target?: string;
};

export interface VaultServiceOptions {
  store: SessionStore;
  /** The Tenant key-encryption key. May read or create the key file. */
  kek: () => Buffer;
}

export class VaultService {
  private readonly store: SessionStore;
  private readonly kek: () => Buffer;

  constructor(options: VaultServiceOptions) {
    this.store = options.store;
    this.kek = options.kek;
  }

  // --- an Environment's vault (caller's transaction) ------------------------------

  /**
   * Creates Environment `environmentId`'s vault (D56), in the transaction that creates it; answers
   * its id, `id` when given (a fork's, whose secrets were sealed for it first).
   */
  async createEnvironmentVault(t: Tx, environmentId: string, actor: string, id: string = randomUUID()): Promise<string> {
    const row: VaultRow = {
      id,
      name: environmentId,
      metadataJson: null,
      createdAt: new Date().toISOString(),
      environmentId,
    };
    await t.insertVault(row);
    await this.audit(t, { actor, action: "create", vaultId: row.id, target: environmentId, outcome: "created" });
    return row.id;
  }

  /**
   * Deletes Environment `environmentId`'s vault and its credentials, with their audit rows, in
   * the transaction that deletes the Environment: no release or tool call finds them after it
   * commits.
   */
  async deleteEnvironmentVault(t: Tx, environmentId: string, actor: string): Promise<void> {
    const vault = await t.vaultOfEnvironment(environmentId);
    if (!vault) return;
    for (const credential of await t.credentialsForVault(vault.id))
      await this.audit(t, {
        actor,
        action: "delete",
        vaultId: vault.id,
        credentialId: credential.id,
        target: environmentId,
        outcome: "deleted",
      });
    await t.deleteVault(vault.id);
    await this.audit(t, { actor, action: "delete", vaultId: vault.id, target: environmentId, outcome: "deleted" });
  }

  /**
   * Seals Environment `from`'s secrets again for vault `vaultId`, a fork's new vault (Q15): each
   * value is unsealed and sealed under the new vault's and credential's ids, which its AAD binds.
   * Needs the vault key, so callers reach it through `Keys`; it reads `from` in its own
   * transaction and writes nothing. With `slots` (what the fork runs declares secret slots, D64),
   * only the names it declares are sealed, each with its slot's binding; a value the slot's type
   * cannot take is left behind. The fork's transaction inserts the copies
   * (`insertEnvironmentSecretCopies`).
   */
  async sealEnvironmentSecretCopies(
    from: string,
    vaultId: string,
    slots?: Readonly<Record<string, Record<string, unknown>>> | null,
  ): Promise<SealedSecretCopies> {
    const kek = this.kek();
    const rows = await this.store.tx(async (t) => {
      const source = await t.vaultOfEnvironment(from);
      return source ? (await t.credentialsForVault(source.id)).filter(isUserCredential) : [];
    });
    const sealed: UserCredentialRow[] = [];
    const dropped: string[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      const payload = readPayload(kek, row);
      let type = row.type;
      let binding = credentialBinding(row);
      let value = payload;
      if (slots) {
        const slot = slots[row.name];
        const rebound = slot === undefined ? undefined : rebind(row.name, slot, row, payload, binding);
        if (rebound === undefined) {
          dropped.push(row.name);
          continue;
        }
        ({ type, binding, payload: value } = rebound);
        try {
          conflictOf(type, binding, sealed);
        } catch (error) {
          if (!(error instanceof VaultError)) throw error;
          dropped.push(row.name);
          continue;
        }
      }
      const id = randomUUID();
      sealed.push({
        id,
        vaultId,
        name: row.name,
        type,
        bindingJson: JSON.stringify(binding),
        expiresAt: row.expiresAt,
        createdAt: now,
        rotatedAt: null,
        ...encryptSecret(kek, credentialAad(vaultId, id, type, binding), Buffer.from(JSON.stringify(value), "utf8")),
      });
    }
    return {
      copies: sealed.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        bindingJson: row.bindingJson,
        expiresAt: row.expiresAt,
        kekId: row.kekId,
        nonce: Buffer.from(row.nonce).toString("base64"),
        ciphertext: Buffer.from(row.ciphertext).toString("base64"),
        wrappedDek: Buffer.from(row.wrappedDek).toString("base64"),
      })),
      dropped: dropped.sort(),
    };
  }

  /**
   * Inserts a fork's sealed copies (`sealEnvironmentSecretCopies`) into vault `vaultId`, in the
   * transaction that creates the fork, with an audit row each naming `from`. Reads no secret.
   */
  async insertEnvironmentSecretCopies(
    t: Tx,
    vaultId: string,
    from: string,
    actor: string,
    sealed: SealedSecretCopies,
  ): Promise<{ copied: string[]; dropped: string[] }> {
    const now = new Date().toISOString();
    for (const copy of sealed.copies) {
      await t.insertCredential({
        id: copy.id,
        vaultId,
        name: copy.name,
        type: copy.type,
        bindingJson: copy.bindingJson,
        expiresAt: copy.expiresAt,
        createdAt: now,
        rotatedAt: null,
        kekId: copy.kekId,
        nonce: Buffer.from(copy.nonce, "base64"),
        ciphertext: Buffer.from(copy.ciphertext, "base64"),
        wrappedDek: Buffer.from(copy.wrappedDek, "base64"),
      });
      await this.audit(t, { actor, action: "create", vaultId, credentialId: copy.id, target: from, outcome: "copied" });
    }
    return { copied: sealed.copies.map((copy) => copy.name).sort(), dropped: [...sealed.dropped] };
  }

  // --- an Environment's secrets ----------------------------------------------------

  /**
   * `PUT /v1/agents/{id}/secrets/{name}`: creates or replaces one credential. The same
   * name and type keeps the credential's id and re-seals its value and binding; another type
   * replaces it. Refused (`409 credential_conflict`) when another credential of the vault is
   * bound to one of its hosts or to its URL. Runs under the Environment row's lock, which also
   * orders it with session opens and deletes, and counts as the Environment's use.
   */
  async putEnvironmentSecret(
    environmentId: string,
    name: string,
    body: PutAgentSecretRequest,
    actor: string,
  ): Promise<AgentSecretView> {
    const invalid = environmentSecretNameError(body.type, name);
    if (invalid) throw new VaultError(400, invalid);
    let payload: SecretPayload;
    let binding: CredentialBinding;
    if (body.type === "environment_secret" || body.type === "environment_variable")
      ({ payload, binding } = environmentCredential(name, body));
    else {
      const url = normalizeVaultUrl(body.url);
      payload = payloadOf(body);
      binding = bindingOf(url, payload, body);
    }
    const kek = this.kek();
    return this.store.tx(async (t) => {
      const vault = await this.environmentVault(t, environmentId, { lock: true });
      const now = new Date().toISOString();
      const others = (await t.credentialsForVault(vault.id))
        .filter(isUserCredential)
        .filter((row) => row.name !== name);
      conflictOf(body.type, binding, others);
      const existing = await t.credentialByName(vault.id, name);
      let row: UserCredentialRow;
      if (existing && isUserCredential(existing) && existing.type === body.type) {
        row = await this.writePayload(t, kek, existing, payload, binding, now);
        await this.audit(t, { actor, action: "rotate", vaultId: vault.id, credentialId: row.id, outcome: "rotated" });
      } else {
        if (existing) {
          await t.deleteCredential(vault.id, existing.id);
          await this.audit(t, { actor, action: "delete", vaultId: vault.id, credentialId: existing.id, outcome: "deleted" });
        }
        const id = randomUUID();
        const sealed = encryptSecret(
          kek,
          credentialAad(vault.id, id, body.type, binding),
          Buffer.from(JSON.stringify(payload), "utf8"),
        );
        row = {
          id,
          vaultId: vault.id,
          name,
          type: body.type,
          bindingJson: JSON.stringify(binding),
          expiresAt: null,
          createdAt: now,
          rotatedAt: null,
          ...sealed,
        };
        await t.insertCredential(row);
        await this.audit(t, { actor, action: "create", vaultId: vault.id, credentialId: id, outcome: "created" });
      }
      await t.updateEnvironment(environmentId, { lastUsedAt: now }, now);
      return secretViewOf(row);
    });
  }

  /** The Environment's secrets: names, types and bindings, never values. */
  async listEnvironmentSecrets(environmentId: string): Promise<AgentSecretView[]> {
    return this.store.tx(async (t) => {
      const vault = await this.environmentVault(t, environmentId);
      return (await t.credentialsForVault(vault.id))
        .filter(isUserCredential)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(secretViewOf);
    });
  }

  async getEnvironmentSecret(environmentId: string, name: string): Promise<AgentSecretView> {
    return this.store.tx(async (t) => {
      const vault = await this.environmentVault(t, environmentId);
      const row = await t.credentialByName(vault.id, name);
      if (!row || !isUserCredential(row)) throw new VaultError(404, "Secret not found");
      return secretViewOf(row);
    });
  }

  async deleteEnvironmentSecret(
    environmentId: string,
    name: string,
    actor: string,
  ): Promise<{ id: string }> {
    return this.store.tx(async (t) => {
      const vault = await this.environmentVault(t, environmentId, { lock: true });
      const row = await t.credentialByName(vault.id, name);
      if (!row || !isUserCredential(row)) throw new VaultError(404, "Secret not found");
      await t.deleteCredential(vault.id, row.id);
      await this.audit(t, { actor, action: "delete", vaultId: vault.id, credentialId: row.id, outcome: "deleted" });
      const now = new Date().toISOString();
      await t.updateEnvironment(environmentId, { lastUsedAt: now }, now);
      return { id: name };
    });
  }

  /**
   * The variables a session's sandbox commands get (R2c, D50): each `environment_secret`'s name
   * set to the sentinel, and each `environment_variable`'s value, from the Environment's vault.
   * Reads rows only; no plaintext. Run in the caller's transaction.
   */
  async environmentVariables(
    t: Tx,
    environmentId: string | undefined,
  ): Promise<Record<string, string>> {
    if (environmentId === undefined) return {};
    const vault = await t.vaultOfEnvironment(environmentId);
    if (!vault) return {};
    const environment: Record<string, string> = {};
    for (const row of await t.credentialsForVault(vault.id)) {
      if (row.type !== "environment_secret" && row.type !== "environment_variable") continue;
      const binding = JSON.parse(row.bindingJson) as CredentialBinding;
      if (row.type === "environment_secret") environment[binding.secretName!] = ENVIRONMENT_SECRET_SENTINEL;
      else environment[binding.variableName!] = binding.variableValue!;
    }
    return environment;
  }

  /**
   * The header egress-gate sets on a request from Environment `environmentId`'s sandbox to
   * `host` (R2c, D50): the `environment_secret` of its vault bound to `host`, its value unsealed
   * and rendered into its format. `none` when no secret is bound to the host; `refused` when the
   * sealed value cannot be read. One query and one unseal per call; nothing is cached (E3).
   * Plaintext exists only in the returned header.
   */
  async releaseEnvironmentSecret(input: {
    environmentId: string;
    host: string;
  }): Promise<
    | { status: "none" }
    | { status: "released"; header: string; value: string; credentialId: string }
    | { status: "refused"; reason: "ambiguous" | "unreadable" }
  > {
    const found = await this.store.tx((t) => environmentSecretsFor(t, input.environmentId, input.host));
    if (found.length === 0) return { status: "none" };
    if (found.length > 1) return { status: "refused", reason: "ambiguous" };
    const row = found[0]!;
    let payload: SecretPayload;
    try {
      payload = readPayload(this.kek(), row);
    } catch (error) {
      if (!(error instanceof VaultCryptoError)) throw error;
      return { status: "refused", reason: "unreadable" };
    }
    if (!payload.value) return { status: "refused", reason: "unreadable" };
    const inject = credentialBinding(row).inject ?? ENVIRONMENT_SECRET_DEFAULT_INJECT;
    return { status: "released", header: inject.header, value: renderInjectFormat(inject.format, payload.value), credentialId: row.id };
  }

  /** Whether an `environment_secret` of Environment `environmentId` is bound to `host`. */
  async environmentSecretBound(environmentId: string, host: string): Promise<boolean> {
    return (await this.store.tx((t) => environmentSecretsFor(t, environmentId, host))).length > 0;
  }

  // --- use ---------------------------------------------------------------------

  /**
   * The headers a request to `url` carries: the credential of the Environment's vault bound to
   * it, or none (`unauthenticated`) without an Environment or such a credential.
   */
  async authorize(input: {
    /** The session the request is made for; absent for a tool preview (R2b C12). */
    sessionId?: string;
    environmentId?: string;
    url: string;
  }): Promise<AuthorizeResult> {
    const url = normalizeVaultUrl(input.url);
    const environmentId = input.environmentId;
    if (environmentId === undefined) return { status: "unauthenticated", url, headers: {} };
    const decided = await this.store.tx(
      async (t): Promise<{ result: AuthorizeResult } | { row: UserCredentialRow }> => {
        const vault = await t.vaultOfEnvironment(environmentId);
        if (!vault) {
          await this.audit(t, {
            actor: "host",
            action: "use",
            sessionId: input.sessionId,
            target: url,
            outcome: "refused",
          });
          return { result: { status: "refused", url, credentialIds: [], reason: "vault_missing" } };
        }
        const matches = (await t.credentialsForVault(vault.id))
          .filter(isUserCredential)
          .filter((row) => bindingUrl(row) === url)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (matches.length === 0) return { result: { status: "unauthenticated", url, headers: {} } };
        if (matches.length > 1) {
          // Refused at write (D56); kept as a guard.
          await this.audit(t, {
            actor: "host",
            action: "use",
            vaultId: vault.id,
            sessionId: input.sessionId,
            target: url,
            outcome: "refused",
          });
          return {
            result: { status: "refused", url, credentialIds: matches.map((row) => row.id), reason: "ambiguous" },
          };
        }
        return { row: matches[0]! };
      },
    );
    if ("result" in decided) return decided.result;

    // Committed. Plaintext exists only from here to the return.
    const row = decided.row;
    const kek = this.kek();
    let payload: SecretPayload;
    try {
      payload = readPayload(kek, row);
    } catch (error) {
      if (!(error instanceof VaultCryptoError)) throw error;
      await this.store.tx((t) =>
        this.audit(t, {
          actor: "host",
          action: "use",
          vaultId: row.vaultId,
          credentialId: row.id,
          sessionId: input.sessionId,
          target: url,
          outcome: "refused",
        }),
      );
      return { status: "refused", url, credentialIds: [row.id], reason: "unreadable" };
    }
    const headers = sendHeaders(row, payload);
    if (!headers) return { status: "refused", url, credentialIds: [row.id], reason: "unreadable" };
    await this.store.tx((t) =>
      this.audit(t, {
        actor: "host",
        action: "use",
        vaultId: row.vaultId,
        credentialId: row.id,
        sessionId: input.sessionId,
        target: url,
        outcome: "approved",
      }),
    );
    const binding = credentialBinding(row);
    return {
      status: "authorized",
      url,
      headers,
      ...(binding.via === undefined ? {} : { via: binding.via }),
      ...(binding.identity === undefined ? {} : { identity: binding.identity }),
    };
  }

  // --- coverage --------------------------------------------------------------------

  /**
   * What a session on Agent `request.agentId` would send for each URL `manifest` (its manifest
   * version's loop manifest) names (`credentialNeeds`), decided as `authorize` decides a call:
   * the credential of the Agent's vault bound to the URL. Reads no secret, writes no audit row.
   */
  async coverage(
    manifest: AgentManifest | WorkflowManifest,
    request: CredentialCoverageRequest,
  ): Promise<CredentialCoverage> {
    const environmentId: string | undefined = request.agentId;
    return this.store.tx(async (t) => {
      const credentials: { row: VaultCredentialRow; url?: string }[] = [];
      {
        const vault = await this.environmentVault(t, environmentId);
        for (const row of await t.credentialsForVault(vault.id))
          if (isUserCredential(row)) credentials.push({ row, url: bindingUrl(row) });
      }
      const entries = credentialNeeds(manifest).map((need): CredentialCoverageEntry => {
        let url: string;
        try {
          url = normalizeVaultUrl(need.url);
        } catch (error) {
          if (!(error instanceof VaultError)) throw error;
          return coverageEntry(need, need.url, undefined, environmentId, error.message);
        }
        const bound = credentials.find((item) => item.url === url);
        return coverageEntry(need, url, bound && coverageCredential(environmentId!, bound.row), environmentId);
      });
      return {
        agentId: request.agentId,
        complete: entries.every((entry) => entry.status === "covered"),
        entries,
      };
    });
  }

  // --- host model ----------------------------------------------------------------

  async getHostModel(): Promise<HostModelView> {
    return this.store.tx((t) => this.hostModelView(t));
  }

  async listHostProviders(): Promise<{ providers: HostModelProviderInfo[] }> {
    return this.store.tx(async (t) => {
      const active = await activeProviderId(t);
      const added = await readAddedInputs(t);
      const catalog = new Map(
        hostModelCatalog().providers.map((provider) => [provider.id, provider.name]),
      );
      const providers = (await hostModelRows(t)).map((row) => {
        const binding = modelBinding(row);
        const inputs = inputsOfHostModel({ configured: true, ...binding }, added);
        return {
          id: binding.provider,
          name:
            catalog.get(binding.provider) ??
            (binding.provider === "custom"
              ? "Custom OpenAI-compatible"
              : binding.provider),
          model: binding.model,
          authType: binding.authType,
          ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
          ...(binding.settings ? { settings: binding.settings } : {}),
          ...(inputs ? { inputs } : {}),
          lastUpdated: row.rotatedAt ?? row.createdAt,
          active: binding.provider === active,
        };
      });
      providers.sort((left, right) => left.name.localeCompare(right.name));
      return { providers };
    });
  }

  async putHostModel(body: PutHostModelRequest): Promise<HostModelView> {
    const kek = this.kek();
    return this.store.tx((t) =>
      this.replay(t, `host-model:${body.idempotencyKey}`, body, async () => {
        this.validateHostModel(body);
        await this.ensureHostVault(t);
        const credentialId = hostModelCredentialId(body.provider);
        await this.deleteHostProviderRows(t, body.provider);
        const payload: HostSecretPayload =
          body.auth.type === "api_key"
            ? {
                apiKey: body.auth.key,
                ...(body.auth.env ? { env: body.auth.env } : {}),
              }
            : { oauth: body.auth };
        await this.insertHostCredential(t, kek, {
          id: credentialId,
          provider: body.provider,
          model: body.model,
          baseUrl: body.baseUrl,
          settings: body.settings,
          authType: body.auth.type,
          payload,
        });
        await this.setActiveProvider(t, body.provider);
        await this.audit(t, {
          actor: "application",
          action: "rotate",
          vaultId: HOST_VAULT_ID,
          credentialId,
          outcome: "rotated",
        });
        return this.hostModelView(t);
      }),
    );
  }

  async selectHostModel(body: SelectHostModelRequest): Promise<HostModelView> {
    const kek = this.kek();
    return this.store.tx((t) =>
      this.replay(t, `host-model-select:${body.idempotencyKey}`, body, async () => {
        this.validateHostModel(body);
        const row = await hostCredentialRowFor(t, body.provider);
        if (!row)
          throw new VaultError(404, "Model provider is not configured");
        const binding = modelBinding(row);
        const payload = readHostPayload(kek, row, binding);
        const credentialId = hostModelCredentialId(body.provider);
        await this.deleteHostProviderRows(t, body.provider);
        await this.insertHostCredential(t, kek, {
          id: credentialId,
          provider: body.provider,
          model: body.model,
          baseUrl: body.baseUrl,
          // Selecting a model keeps the endpoint's settings.
          settings: binding.settings,
          authType: binding.authType,
          payload,
        });
        await this.setActiveProvider(t, body.provider);
        await this.audit(t, {
          actor: "application",
          action: "rotate",
          vaultId: HOST_VAULT_ID,
          credentialId,
          outcome: "rotated",
        });
        return this.hostModelView(t);
      }),
    );
  }

  // --- internals -----------------------------------------------------------------

  private async replay<T>(
    t: Tx,
    key: string,
    body: unknown,
    create: () => Promise<T>,
  ): Promise<T> {
    const hash = createHash("sha256")
      .update(requestHash(body))
      .digest("hex");
    const existing = await t.getVaultIdempotency(key);
    if (existing) {
      if (existing.bodyHash !== hash)
        throw new VaultError(409, "Idempotency key already binds another request");
      return JSON.parse(existing.response) as T;
    }
    const created = await create();
    await t.insertVaultIdempotency({
      id: key,
      bodyHash: hash,
      response: JSON.stringify(created),
    });
    return created;
  }

  /** Re-seals a user credential's payload with its new binding and returns the updated row. */
  private async writePayload(
    t: Tx,
    kek: Buffer,
    row: UserCredentialRow,
    payload: SecretPayload,
    binding: CredentialBinding,
    rotatedAt: string,
  ): Promise<UserCredentialRow> {
    const sealed = encryptSecret(
      kek,
      credentialAad(row.vaultId, row.id, row.type, binding),
      Buffer.from(JSON.stringify(payload), "utf8"),
    );
    const patch = { rotatedAt, bindingJson: JSON.stringify(binding), ...sealed };
    if (!(await t.updateCredential(row.vaultId, row.id, patch)))
      throw new VaultError(404, "Credential not found");
    return { ...row, ...patch };
  }

  /**
   * The vault of a live Environment (not being deleted), or the 404 of a missing one. With
   * `lock`, the Environment's row is locked until the transaction ends.
   */
  private async environmentVault(
    t: Tx,
    environmentId: string,
    options: { lock?: boolean } = {},
  ): Promise<VaultRow> {
    const environment = await t.environment(environmentId, options);
    const vault =
      environment && environment.pod?.desired !== "deleted"
        ? await t.vaultOfEnvironment(environmentId)
        : undefined;
    if (!vault) throw new VaultError(404, "Agent not found");
    return vault;
  }

  private async ensureHostVault(t: Tx): Promise<void> {
    if (await t.getVault(HOST_VAULT_ID)) return;
    await t.insertVault({
      id: HOST_VAULT_ID,
      name: "Host",
      metadataJson: null,
      createdAt: new Date().toISOString(),
      environmentId: null,
    });
  }

  private validateHostModel(body: {
    provider: string;
    model: string;
    baseUrl?: string;
    settings?: CustomModelSettings;
  }): void {
    if (body.settings && body.provider !== "custom")
      throw new VaultError(
        400,
        "Model settings (context window, output limit, reasoning, inputs, compat) apply only to a custom provider.",
      );
    if (body.provider === "custom") {
      // A custom endpoint is OpenAI-compatible: it reads only what that API carries (protocol 12).
      const inputsRefused =
        body.settings?.inputs &&
        inputsError({ api: "openai-completions", input: ["text", "image"] }, body.settings.inputs);
      if (inputsRefused) throw new VaultError(400, inputsRefused);
      if (!body.baseUrl)
        throw new VaultError(
          400,
          "A base URL is required for a custom provider.",
        );
      let url: URL;
      try {
        url = new URL(body.baseUrl);
      } catch {
        throw new VaultError(400, "Base URL must be an HTTP(S) URL.");
      }
      if (!["http:", "https:"].includes(url.protocol))
        throw new VaultError(400, "Base URL must be an HTTP(S) URL.");
      return;
    }
    if (body.baseUrl)
      throw new VaultError(
        400,
        "A base URL is only valid for a custom provider.",
      );
    const provider = hostModelCatalog().providers.find(
      (item) => item.id === body.provider,
    );
    if (!provider) throw new VaultError(400, "Unknown model provider.");
    if (!provider.models.some((item) => item.id === body.model))
      throw new VaultError(400, "Unknown model.");
  }

  private async insertHostCredential(
    t: Tx,
    kek: Buffer,
    input: {
      id: string;
      provider: string;
      model: string;
      baseUrl?: string;
      settings?: CustomModelSettings;
      authType: "api_key" | "oauth";
      payload: HostSecretPayload;
    },
  ): Promise<void> {
    const sealed = encryptSecret(
      kek,
      hostModelAad(input.provider, input.model),
      Buffer.from(JSON.stringify(input.payload), "utf8"),
    );
    await t.insertCredential({
      id: input.id,
      vaultId: HOST_VAULT_ID,
      name: input.provider,
      type: "model",
      bindingJson: JSON.stringify({
        provider: input.provider,
        model: input.model,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.settings && Object.keys(input.settings).length
          ? { settings: input.settings }
          : {}),
        authType: input.authType,
      }),
      expiresAt: null,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      ...sealed,
    });
  }

  private async hostModelView(t: Tx): Promise<HostModelView> {
    const row = await activeHostCredentialRow(t);
    if (!row) return { configured: false };
    const binding = modelBinding(row);
    return {
      configured: true,
      provider: binding.provider,
      model: binding.model,
      authType: binding.authType,
      ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
      ...(binding.settings ? { settings: binding.settings } : {}),
    };
  }





  private async setActiveProvider(t: Tx, provider: string): Promise<void> {
    await this.ensureHostVault(t);
    await t.updateVaultMetadata(
      HOST_VAULT_ID,
      JSON.stringify({ activeProvider: provider }),
    );
  }

  private async deleteHostProviderRows(t: Tx, provider: string): Promise<void> {
    const ids = (await hostModelRows(t))
      .filter((row) => modelBinding(row).provider === provider)
      .map((row) => row.id);
    ids.push(hostModelCredentialId(provider));
    for (const id of new Set(ids)) await t.deleteCredential(HOST_VAULT_ID, id);
  }

  private async audit(t: Tx, entry: AuditEntry): Promise<void> {
    await t.insertVaultAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      vaultId: entry.vaultId ?? null,
      credentialId: entry.credentialId ?? null,
      sessionId: entry.sessionId ?? null,
      target: entry.target ?? null,
      outcome: entry.outcome,
    });
  }
}

function isUserCredential(row: VaultCredentialRow): row is UserCredentialRow {
  return row.type !== "model";
}

function bindingUrl(row: VaultCredentialRow): string | undefined {
  return (JSON.parse(row.bindingJson) as { url?: string }).url;
}

/** Where a credential is, for coverage: never its value. */
function coverageCredential(environmentId: string, row: VaultCredentialRow): CoverageCredential {
  const via = (JSON.parse(row.bindingJson) as { via?: string }).via;
  return { agentId: environmentId, name: row.name, ...(via === undefined ? {} : { via }) };
}

/** One coverage entry, with the sentence that says what the session would do. */
function coverageEntry(
  need: CredentialNeed,
  url: string,
  credential: CoverageCredential | undefined,
  environmentId: string | undefined,
  invalid?: string,
): CredentialCoverageEntry {
  const required = need.kind === "http";
  const where =
    environmentId === undefined
      ? "Without an Agent, no credential is sent"
      : `Agent ${environmentId} holds no credential for this URL`;
  const message =
    invalid !== undefined
      ? `No credential can be bound to this URL (${invalid}).`
      : credential !== undefined
        ? `Sends '${credential.name}' from Agent ${credential.agentId}${credential.via ? ` through ${credential.via}` : ""}.`
        : required
          ? `${where}: each call fails with http.credential.`
          : `${where}: the server is called without one, which only a public server accepts.`;
  return {
    kind: need.kind,
    ...(need.agentId === undefined ? {} : { agentId: need.agentId }),
    ...(need.stage === undefined ? {} : { stage: need.stage }),
    name: need.name,
    serverName: need.serverName,
    url,
    required,
    status: credential === undefined ? "missing" : "covered",
    ...(credential === undefined ? {} : { credential }),
    message,
  };
}

/**
 * Refuses a write that would bind a second credential to a host or a URL (D56): `others` are
 * the vault's other credentials.
 */
function conflictOf(
  type: PutAgentSecretRequest["type"],
  binding: CredentialBinding,
  others: readonly UserCredentialRow[],
): void {
  if (type === "environment_secret") {
    for (const row of others) {
      if (row.type !== "environment_secret") continue;
      const hosts = credentialBinding(row).allowedHosts ?? [];
      const host = (binding.allowedHosts ?? []).find((item) => hosts.includes(item));
      if (host !== undefined)
        throw new VaultError(409, `${row.name} is already bound to ${host}`, {
          code: "credential_conflict",
          details: { host, existing: row.name },
        });
    }
  } else if (type === "bearer" || type === "headers") {
    const existing = others.find(
      (row) => (row.type === "bearer" || row.type === "headers") && credentialBinding(row).url === binding.url,
    );
    if (existing)
      throw new VaultError(409, `${existing.name} is already bound to ${binding.url}`, {
        code: "credential_conflict",
        details: { url: binding.url, existing: existing.name },
      });
  }
}

function credentialBinding(row: UserCredentialRow): CredentialBinding {
  return JSON.parse(row.bindingJson) as CredentialBinding;
}

/** A secret as `GET .../secrets/{name}` shows it: never its value. */
function secretViewOf(row: UserCredentialRow): AgentSecretView {
  const binding = credentialBinding(row);
  return {
    name: row.name,
    type: row.type,
    binding:
      row.type === "environment_secret"
        ? {
            allowedHosts: binding.allowedHosts!,
            inject: binding.inject ?? { ...ENVIRONMENT_SECRET_DEFAULT_INJECT },
          }
        : row.type === "environment_variable"
          ? {}
          : { url: binding.url! },
    ...(binding.headerNames === undefined ? {} : { headerNames: binding.headerNames }),
    ...(binding.via === undefined ? {} : { via: binding.via }),
    ...(binding.identity === undefined ? {} : { identity: binding.identity }),
    createdAt: row.createdAt,
    ...(row.rotatedAt ? { rotatedAt: row.rotatedAt } : {}),
  };
}

function readPayload(kek: Buffer, row: UserCredentialRow): SecretPayload {
  const aad = credentialAad(row.vaultId, row.id, row.type, credentialBinding(row));
  const plaintext = decryptSecret(
    kek,
    aad,
    Buffer.from(row.nonce),
    Buffer.from(row.ciphertext),
    Buffer.from(row.wrappedDek),
    row.kekId,
  );
  try {
    return JSON.parse(plaintext.toString("utf8")) as SecretPayload;
  } finally {
    plaintext.fill(0);
  }
}

/** The host vault's model credential rows that parse. */
export async function hostModelRows(t: Tx): Promise<VaultCredentialRow[]> {
  return (
    await t.credentialsForVault(HOST_VAULT_ID, { type: "model" })
  ).filter((row) => {
    try {
      modelBinding(row);
      return true;
    } catch {
      return false;
    }
  });
}

/** The host model credential of `provider`. */
export async function hostCredentialRowFor(
  t: Tx,
  provider: string,
): Promise<VaultCredentialRow | undefined> {
  const preferred = hostModelCredentialId(provider);
  const rows = await hostModelRows(t);
  return (
    rows.find((row) => row.id === preferred) ??
    rows.find((row) => modelBinding(row).provider === provider)
  );
}

/** The provider the host model selection names, or the only (or legacy) one configured. */
export async function activeProviderId(t: Tx): Promise<string | undefined> {
  const vault = await t.getVault(HOST_VAULT_ID);
  if (vault?.metadataJson) {
    let activeProvider: unknown;
    try {
      activeProvider = (
        JSON.parse(vault.metadataJson) as { activeProvider?: unknown }
      ).activeProvider;
    } catch {
      /* Fall through to the only configured provider. */
    }
    if (typeof activeProvider === "string" && activeProvider) {
      try {
        if (await hostCredentialRowFor(t, activeProvider))
          return activeProvider;
      } catch {
        /* An invalid provider id falls through, as before. */
      }
    }
  }
  const rows = await hostModelRows(t);
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return modelBinding(rows[0]!).provider;
  const legacy = rows.find((row) => row.id === HOST_MODEL_ID);
  if (legacy) return modelBinding(legacy).provider;
  return modelBinding(rows[0]!).provider;
}

/** The active host model credential row (ciphertext), in `t`. */
export async function activeHostCredentialRow(
  t: Tx,
): Promise<VaultCredentialRow | undefined> {
  const active = await activeProviderId(t);
  if (!active) return undefined;
  return hostCredentialRowFor(t, active);
}

export function readHostPayload(
  kek: Buffer,
  row: VaultCredentialRow,
  binding: ModelBinding,
): HostSecretPayload {
  const plaintext = decryptSecret(
    kek,
    hostModelAad(binding.provider, binding.model),
    Buffer.from(row.nonce),
    Buffer.from(row.ciphertext),
    Buffer.from(row.wrappedDek),
    row.kekId,
  );
  try {
    return JSON.parse(plaintext.toString("utf8")) as HostSecretPayload;
  } finally {
    plaintext.fill(0);
  }
}

/** The sealed part of a tool credential: a token, or a header map with lower-cased names. */
function payloadOf(
  auth: { type: "bearer"; value: string } | { type: "headers"; headers: Record<string, string> },
): SecretPayload {
  if (auth.type === "bearer") return { token: auth.value };
  return {
    headers: Object.fromEntries(
      Object.entries(auth.headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  };
}

/** The unsealed binding of a credential that sends `payload`; refuses a reserved header name. */
function bindingOf(
  url: string,
  payload: SecretPayload,
  routing: { via?: string | null; identity?: CredentialIdentity | null },
): CredentialBinding {
  const sent = payload.headers ? Object.keys(payload.headers) : ["authorization"];
  checkCredentialHeaders(sent, routing.identity ?? undefined);
  return {
    url,
    ...(routing.via ? { via: routing.via } : {}),
    ...(routing.identity ? { identity: { header: routing.identity.header.toLowerCase() } } : {}),
    ...(payload.headers ? { headerNames: sent } : {}),
  };
}

/** The headers a credential sends, or undefined when its payload holds none. */
function sendHeaders(
  row: UserCredentialRow,
  payload: SecretPayload,
): Record<string, string> | undefined {
  if (row.type === "headers")
    return payload.headers && Object.keys(payload.headers).length > 0
      ? { ...payload.headers }
      : undefined;
  return payload.token ? { authorization: `Bearer ${payload.token}` } : undefined;
}

type ModelBinding = {
  provider: string;
  model: string;
  baseUrl?: string;
  settings?: CustomModelSettings;
  authType: "api_key" | "oauth";
};

type HostSecretPayload = {
  apiKey?: string;
  env?: Record<string, string>;
  oauth?: HostModelSecret["credential"];
};

export function modelBinding(row: VaultCredentialRow): ModelBinding {
  const binding = JSON.parse(row.bindingJson) as ModelBinding;
  if (!binding.provider || !binding.model || !binding.authType)
    throw new VaultError(500, "Host model credential is unreadable");
  return binding;
}

function hostModelCredentialId(provider: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(provider))
    throw new VaultError(400, "Invalid provider id");
  return `${HOST_MODEL_ID}:${provider}`;
}

export function hostModelAad(provider: string, model: string): Buffer {
  return Buffer.from(
    canonical({
      scope: "host",
      vaultId: HOST_VAULT_ID,
      credentialId: HOST_MODEL_ID,
      type: "model",
      provider,
      model,
    }),
    "utf8",
  );
}

/**
 * What a user credential's ciphertext is bound to: its vault, id, type and URL; for an
 * `environment_secret` (R2c) also its variable, hosts and header, so the value can never be sent
 * anywhere else without a new seal.
 */
function credentialAad(
  vaultId: string,
  credentialId: string,
  type: string,
  binding: CredentialBinding,
): Buffer {
  return Buffer.from(
    canonical(
      type === "environment_secret"
        ? {
            vaultId,
            credentialId,
            type,
            secretName: binding.secretName,
            allowedHosts: binding.allowedHosts,
            inject: binding.inject ?? null,
          }
        : { vaultId, credentialId, type, url: binding.url },
    ),
    "utf8",
  );
}

/**
 * A copied credential's type, binding and payload under a slot of the fork (D64): its value with
 * the slot's binding, or undefined when the slot's type cannot take it.
 */
function rebind(
  name: string,
  slot: Record<string, unknown>,
  row: UserCredentialRow,
  payload: SecretPayload,
  binding: CredentialBinding,
): { type: UserCredentialRow["type"]; binding: CredentialBinding; payload: SecretPayload } | undefined {
  const type = slot.type as UserCredentialRow["type"];
  const value =
    row.type === "environment_variable" ? binding.variableValue : row.type === "bearer" ? payload.token : payload.value;
  try {
    if (type === "environment_secret" || type === "environment_variable") {
      if (value === undefined) return undefined;
      const made = environmentCredential(name, { ...slot, type, value } as Parameters<typeof environmentCredential>[1]);
      return { type, ...made };
    }
    const auth =
      type === "headers"
        ? payload.headers === undefined
          ? undefined
          : ({ type, headers: payload.headers } as const)
        : value === undefined
          ? undefined
          : ({ type: "bearer", value } as const);
    if (auth === undefined) return undefined;
    const sealed = payloadOf(auth);
    const routing = slot as { url: string; via?: string | null; identity?: CredentialIdentity | null };
    return { type, payload: sealed, binding: bindingOf(normalizeVaultUrl(routing.url), sealed, routing) };
  } catch (error) {
    if (error instanceof VaultError) return undefined;
    throw error;
  }
}

/** The sealed payload and unsealed binding of a shell credential named `name` (R2c). */
function environmentCredential(
  name: string,
  body:
    | { type: "environment_secret"; value: string; allowedHosts: string[]; inject?: EnvironmentSecretInject }
    | { type: "environment_variable"; value: string },
): { payload: SecretPayload; binding: CredentialBinding } {
  if (body.type === "environment_variable")
    return { payload: {}, binding: { variableName: name, variableValue: body.value } };
  if (body.inject) checkCredentialHeaders([body.inject.header.toLowerCase()], undefined);
  return {
    payload: { value: body.value },
    binding: {
      secretName: name,
      allowedHosts: body.allowedHosts.map((host) => host.toLowerCase()),
      ...(body.inject ? { inject: { header: body.inject.header, format: body.inject.format } } : {}),
    },
  };
}

function requestHash(body: unknown): string {
  const { requestId: _requestId, ...rest } = body as { requestId?: string };
  return canonical(rest);
}

/** The `environment_secret` credentials of Environment `environmentId` bound to `host` (R2c). */
async function environmentSecretsFor(t: Tx, environmentId: string, host: string): Promise<UserCredentialRow[]> {
  const lower = host.toLowerCase();
  const vault = await t.vaultOfEnvironment(environmentId);
  if (!vault) return [];
  return (await t.credentialsForVault(vault.id)).filter(
    (row): row is UserCredentialRow =>
      row.type === "environment_secret" &&
      (credentialBinding(row as UserCredentialRow).allowedHosts ?? []).includes(lower),
  );
}
