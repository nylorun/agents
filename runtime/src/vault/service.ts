/**
 * The Runtime vault (docs/design/runtime/vault.md, architecture §12.9):
 * administer vaults and credentials, attach them to sessions, and authorize
 * outbound MCP calls. Storage is the async Session Store (`store/types.ts`);
 * this module holds no SQL.
 *
 * ## Public surface
 *
 * ```ts
 * new VaultService({ store: SessionStore, kek: () => Buffer })
 *
 * // Administration: each opens its own transaction and writes its audit rows
 * // in that transaction. Creates and rotations replay by idempotency key.
 * createVault(body: CreateVaultRequest): Promise<VaultInfo>
 * listVaults(ownerUserId: string | undefined, options?: { installation?: boolean }): Promise<VaultInfo[]>
 * getVault(id: string): Promise<VaultInfo>
 * deleteVault(id: string): Promise<{ id: string }>
 * createCredential(vaultId: string, body: CreateCredentialRequest): Promise<CredentialInfo>
 * listCredentials(vaultId: string): Promise<CredentialInfo[]>
 * getCredential(vaultId: string, id: string): Promise<CredentialInfo>
 * rotateCredential(vaultId: string, id: string, body: RotateCredentialRequest): Promise<CredentialInfo>
 * deleteCredential(vaultId: string, id: string): Promise<{ id: string }>
 *
 * // Attachment: run inside the caller's session PUT transaction.
 * assertAttachment(t: Tx, ownerUserId: string, vaultIds: readonly string[], selections: readonly CredentialSelection[], options?: { opaque?: boolean }): Promise<void>
 * recordAttachment(t: Tx, sessionId: string, vaultIds: readonly string[]): Promise<void>
 *
 * // Use: opens its own transactions; never call it inside one. `sessionCredentials`
 * // (`vault/sources.ts`) calls it for a session's MCP servers and HTTP tools.
 * authorize(input: { sessionId; vaultIds; credentialSelections; url; serverName? }): Promise<AuthorizeResult>
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
 * ## Scopes
 *
 * - `user`: one person's vault (owner `ownerUserId`), attachable only to that person's sessions.
 * - `installation` (`INSTALLATION_OWNER`): the installation's own, created by application keys
 *   only, attachable to any session. Subject and token callers never see one.
 * - `host`: the model vault (`HOST_VAULT_ID`), never listed or attached.
 *
 * ## Transactions and I/O
 *
 * - No network I/O runs inside a transaction. The KEK getter may touch the
 *   filesystem (it creates the key file on first use), so methods that
 *   encrypt or decrypt resolve the KEK before opening their transaction and
 *   do only in-memory crypto inside it.
 * - `authorize` reads the attached vaults and the matching credential rows
 *   (ciphertext only) in one transaction and decides there. A refusal decided
 *   from those rows (missing vault, ambiguous, selection mismatch) writes its
 *   audit row in that same transaction. Decryption happens after it commits,
 *   so the plaintext never enters a transaction. The `use`/`approved` audit
 *   row is written in a final transaction before the header is returned: if
 *   that write fails, `authorize` rejects and no header leaves the vault, so
 *   every approved use has an audit row. Unreadable ciphertext is audited in
 *   its own transaction before the refusal is returned.
 *
 * ## Credentials (R2b C2)
 *
 * A credential is bound to the URL a manifest names and sends a `bearer` token or a `headers`
 * map, both sealed. Its `via` (where requests go, such as a gateway) and `identity` (the header
 * that names the session owner) are not secret: they live unsealed in the binding, beside the
 * URL and the header names, and a rotation keeps them unless it changes them. The seal's AAD
 * binds the type and URL only, and matching is by URL only, so `via` never decides which
 * credential is chosen.
 */
import { createHash, randomUUID } from "node:crypto";
import { INSTALLATION_OWNER } from "@nylorun/core/contracts";
import type {
  CreateCredentialRequest,
  CreateVaultRequest,
  CredentialIdentity,
  CredentialInfo,
  CredentialSelection,
  HostModelProviderInfo,
  HostModelView,
  PutHostModelRequest,
  CustomModelSettings,
  RotateCredentialRequest,
  SelectHostModelRequest,
  VaultInfo,
} from "@nylorun/core/contracts";
import { canonical } from "../store/canonical.js";
import type {
  SessionStore,
  Tx,
  VaultCredentialRow,
  VaultRow,
} from "../store/types.js";
import { decryptSecret, encryptSecret, VaultCryptoError } from "./crypto.js";
import { VaultError } from "./error.js";
import { checkCredentialHeaders } from "./headers.js";
import { hostModelCatalog } from "../model/catalog.js";
import { normalizeVaultUrl } from "./url.js";

export const HOST_VAULT_ID = "host";
const HOST_MODEL_ID = "host-model";

export type HostModelSecret = {
  provider: string;
  model: string;
  baseUrl?: string;
  /** A custom endpoint's window, output limit, reasoning and pi-ai compat (Model Calls §7). */
  settings?: CustomModelSettings;
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
  /** A `headers` credential's map, names lower-cased. */
  headers?: Record<string, string>;
};

type UserCredentialRow = VaultCredentialRow & { type: "bearer" | "headers" };

/** A user credential's `bindingJson`: everything about it that is not secret. */
type CredentialBinding = {
  url: string;
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
      /** The scope of the vault the credential is in. */
      vault: "installation" | "user";
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

  // --- administration --------------------------------------------------------

  async createVault(body: CreateVaultRequest): Promise<VaultInfo> {
    return this.store.tx((t) =>
      this.replay(t, `create-vault:${body.idempotencyKey}`, body, async () => {
        const installation = body.scope === "installation";
        const ownerUserId = installation ? INSTALLATION_OWNER : body.ownerUserId;
        if (!ownerUserId) throw new VaultError(400, "ownerUserId is required for a user vault");
        const row: VaultRow = {
          id: randomUUID(),
          name: body.name,
          ownerUserId,
          metadataJson: body.metadata ? JSON.stringify(body.metadata) : null,
          createdAt: new Date().toISOString(),
          scope: installation ? "installation" : "user",
        };
        await t.insertVault(row);
        await this.audit(t, {
          actor: "application",
          action: "create",
          vaultId: row.id,
          outcome: "created",
        });
        return vaultInfoOf(row);
      }),
    );
  }

  /**
   * One person's vaults, then (with `installation`) the installation vaults. No owner lists
   * the installation vaults only.
   */
  async listVaults(
    ownerUserId: string | undefined,
    options: { installation?: boolean } = {},
  ): Promise<VaultInfo[]> {
    return this.store.tx(async (t) => {
      const own = ownerUserId === undefined ? [] : await t.vaultsByOwner(ownerUserId);
      const shared = options.installation ? await t.installationVaults() : [];
      return [...own, ...shared].map(vaultInfoOf);
    });
  }

  async getVault(id: string): Promise<VaultInfo> {
    return this.store.tx((t) => this.vaultInfo(t, id));
  }

  async deleteVault(id: string): Promise<{ id: string }> {
    return this.store.tx(async (t) => {
      await this.vaultInfo(t, id);
      for (const credential of await t.credentialsForVault(id)) {
        await this.audit(t, {
          actor: "application",
          action: "delete",
          vaultId: id,
          credentialId: credential.id,
          outcome: "deleted",
        });
      }
      await t.deleteVault(id);
      await this.audit(t, {
        actor: "application",
        action: "delete",
        vaultId: id,
        outcome: "deleted",
      });
      return { id };
    });
  }

  async createCredential(
    vaultId: string,
    body: CreateCredentialRequest,
  ): Promise<CredentialInfo> {
    const kek = this.kek();
    return this.store.tx((t) =>
      this.replay(
        t,
        `create-credential:${vaultId}:${body.idempotencyKey}`,
        body,
        async () => {
          await this.vaultInfo(t, vaultId);
          const id = randomUUID();
          const url = normalizeVaultUrl(body.auth.url);
          const type = body.auth.type;
          const payload = payloadOf(body.auth);
          const binding = bindingOf(url, payload, body.auth);
          const sealed = encryptSecret(
            kek,
            credentialAad(vaultId, id, type, url),
            Buffer.from(JSON.stringify(payload), "utf8"),
          );
          const row: UserCredentialRow = {
            id,
            vaultId,
            name: body.name,
            type,
            bindingJson: JSON.stringify(binding),
            expiresAt: null,
            createdAt: new Date().toISOString(),
            rotatedAt: null,
            ...sealed,
          };
          await t.insertCredential(row);
          await this.audit(t, {
            actor: "application",
            action: "create",
            vaultId,
            credentialId: id,
            outcome: "created",
          });
          return credentialInfoOf(row);
        },
      ),
    );
  }

  async listCredentials(vaultId: string): Promise<CredentialInfo[]> {
    return this.store.tx(async (t) => {
      await this.vaultInfo(t, vaultId);
      return (await t.credentialsForVault(vaultId))
        .filter(isUserCredential)
        .map(credentialInfoOf);
    });
  }

  async getCredential(vaultId: string, id: string): Promise<CredentialInfo> {
    return this.store.tx(async (t) =>
      credentialInfoOf(await this.credentialRow(t, vaultId, id)),
    );
  }

  async rotateCredential(
    vaultId: string,
    id: string,
    body: RotateCredentialRequest,
  ): Promise<CredentialInfo> {
    const kek = this.kek();
    return this.store.tx((t) =>
      this.replay(
        t,
        `rotate:${vaultId}:${id}:${body.idempotencyKey}`,
        body,
        async () => {
          const row = await this.credentialRow(t, vaultId, id);
          if (row.type !== body.auth.type)
            throw new VaultError(409, "Credential type cannot change");
          const current = credentialBinding(row);
          const next = payloadOf(body.auth);
          const binding = bindingOf(current.url, next, {
            via: body.auth.via === undefined ? current.via : body.auth.via,
            identity: body.auth.identity === undefined ? current.identity : body.auth.identity,
          });
          const updated = await this.writePayload(
            t,
            kek,
            row,
            next,
            binding,
            new Date().toISOString(),
          );
          await this.audit(t, {
            actor: "application",
            action: "rotate",
            vaultId,
            credentialId: id,
            outcome: "rotated",
          });
          return credentialInfoOf(updated);
        },
      ),
    );
  }

  async deleteCredential(vaultId: string, id: string): Promise<{ id: string }> {
    return this.store.tx(async (t) => {
      await this.credentialRow(t, vaultId, id);
      await t.deleteCredential(vaultId, id);
      await this.audit(t, {
        actor: "application",
        action: "delete",
        vaultId,
        credentialId: id,
        outcome: "deleted",
      });
      return { id };
    });
  }

  // --- attachment (caller's transaction) --------------------------------------

  /**
   * Checks a session's vaults and selections. Run in the session PUT transaction. `opaque`
   * (a request acting for a subject) reports another owner's vault as the 404 of a missing one.
   */
  async assertAttachment(
    t: Tx,
    ownerUserId: string,
    vaultIds: readonly string[],
    selections: readonly CredentialSelection[],
    options: { opaque?: boolean } = {},
  ): Promise<void> {
    if (new Set(vaultIds).size !== vaultIds.length)
      throw new VaultError(400, "Duplicate vault id");
    if (new Set(selections.map((item) => item.serverName)).size !== selections.length)
      throw new VaultError(400, "Duplicate credential selection");
    for (const id of vaultIds) {
      const vault = await t.getVault(id);
      if (!vault) throw new VaultError(404, "Vault not found");
      if (vault.scope === "host")
        throw new VaultError(400, "Host vault cannot be attached to a session");
      // Any session may use the installation's own vaults (F9-D13).
      if (vault.scope === "installation") continue;
      if (vault.ownerUserId !== ownerUserId)
        throw options.opaque
          ? new VaultError(404, "Vault not found")
          : new VaultError(403, "Vault belongs to another user");
    }
    for (const selection of selections) {
      const row = await t.getCredential(selection.credentialId);
      if (!row || !vaultIds.includes(row.vaultId))
        throw new VaultError(400, "Credential is not in an attached vault");
    }
  }

  /** Writes the `attach` audit row. Run in the session PUT transaction. */
  async recordAttachment(
    t: Tx,
    sessionId: string,
    vaultIds: readonly string[],
  ): Promise<void> {
    await this.audit(t, {
      actor: "application",
      action: "attach",
      sessionId,
      target: vaultIds.join(","),
      outcome: "attached",
    });
  }

  // --- use ---------------------------------------------------------------------

  async authorize(input: {
    sessionId: string;
    vaultIds: readonly string[];
    credentialSelections: readonly CredentialSelection[];
    url: string;
    serverName?: string;
  }): Promise<AuthorizeResult> {
    const url = normalizeVaultUrl(input.url);
    const decided = await this.store.tx(
      async (
        t,
      ): Promise<
        { result: AuthorizeResult } | { row: UserCredentialRow; vault: "installation" | "user" }
      > => {
        const scopes = new Map<string, string>();
        for (const id of input.vaultIds) {
          const found = await t.getVault(id);
          if (found) {
            scopes.set(id, found.scope);
            continue;
          }
          await this.audit(t, {
            actor: "host",
            action: "use",
            sessionId: input.sessionId,
            target: url,
            outcome: "refused",
          });
          return {
            result: {
              status: "refused",
              url,
              credentialIds: [],
              reason: "vault_missing",
            },
          };
        }
        const matches: VaultCredentialRow[] = [];
        for (const vaultId of input.vaultIds)
          for (const row of await t.credentialsForVault(vaultId))
            if (bindingUrl(row) === url) matches.push(row);
        matches.sort((a, b) => a.id.localeCompare(b.id));
        if (matches.length === 0)
          return { result: { status: "unauthenticated", url, headers: {} } };
        const selection = input.serverName
          ? input.credentialSelections.find(
              (item) => item.serverName === input.serverName,
            )
          : undefined;
        const chosen = choose(matches, selection);
        if (chosen.kind === "refused") {
          await this.audit(t, {
            actor: "host",
            action: "use",
            sessionId: input.sessionId,
            target: url,
            outcome: "refused",
          });
          return {
            result: {
              status: "refused",
              url,
              credentialIds: chosen.credentialIds,
              reason: chosen.reason,
            },
          };
        }
        return {
          row: chosen.row as UserCredentialRow,
          vault: scopes.get(chosen.row.vaultId) === "installation" ? "installation" : "user",
        };
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
      return {
        status: "refused",
        url,
        credentialIds: [row.id],
        reason: "unreadable",
      };
    }
    const headers = sendHeaders(row, payload);
    if (!headers) {
      return {
        status: "refused",
        url,
        credentialIds: [row.id],
        reason: "unreadable",
      };
    }
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
      vault: decided.vault,
    };
  }

  // --- host model ----------------------------------------------------------------

  async getHostModel(): Promise<HostModelView> {
    return this.store.tx((t) => this.hostModelView(t));
  }

  async listHostProviders(): Promise<{ providers: HostModelProviderInfo[] }> {
    return this.store.tx(async (t) => {
      const active = await activeProviderId(t);
      const catalog = new Map(
        hostModelCatalog().providers.map((provider) => [provider.id, provider.name]),
      );
      const providers = (await hostModelRows(t)).map((row) => {
        const binding = modelBinding(row);
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
      credentialAad(row.vaultId, row.id, row.type, bindingUrl(row)),
      Buffer.from(JSON.stringify(payload), "utf8"),
    );
    const patch = { rotatedAt, bindingJson: JSON.stringify(binding), ...sealed };
    if (!(await t.updateCredential(row.vaultId, row.id, patch)))
      throw new VaultError(404, "Credential not found");
    return { ...row, ...patch };
  }

  private async vaultInfo(t: Tx, id: string): Promise<VaultInfo> {
    const row = await t.getVault(id);
    if (!row || row.scope === "host") throw new VaultError(404, "Vault not found");
    return vaultInfoOf(row);
  }

  private async ensureHostVault(t: Tx): Promise<void> {
    const existing = await t.getVault(HOST_VAULT_ID);
    if (existing?.scope === "host") return;
    if (existing) throw new VaultError(409, "Host vault id is already used");
    await t.insertVault({
      id: HOST_VAULT_ID,
      name: "Host",
      ownerUserId: "host",
      metadataJson: null,
      createdAt: new Date().toISOString(),
      scope: "host",
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
        "Model settings (context window, output limit, reasoning, compat) apply only to a custom provider.",
      );
    if (body.provider === "custom") {
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

  private async credentialRow(
    t: Tx,
    vaultId: string,
    id: string,
  ): Promise<UserCredentialRow> {
    const row = await t.getCredential(id);
    if (!row || row.vaultId !== vaultId || !isUserCredential(row))
      throw new VaultError(404, "Credential not found");
    return row;
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

function vaultInfoOf(row: VaultRow): VaultInfo {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    ...(row.metadataJson
      ? { metadata: JSON.parse(row.metadataJson) as Record<string, string> }
      : {}),
    createdAt: row.createdAt,
  };
}

function credentialBinding(row: UserCredentialRow): CredentialBinding {
  return JSON.parse(row.bindingJson) as CredentialBinding;
}

function credentialInfoOf(row: UserCredentialRow): CredentialInfo {
  const binding = credentialBinding(row);
  return {
    id: row.id,
    vaultId: row.vaultId,
    name: row.name,
    type: row.type,
    binding: { url: binding.url },
    ...(binding.headerNames === undefined ? {} : { headerNames: binding.headerNames }),
    ...(binding.via === undefined ? {} : { via: binding.via }),
    ...(binding.identity === undefined ? {} : { identity: binding.identity }),
    createdAt: row.createdAt,
    ...(row.rotatedAt ? { rotatedAt: row.rotatedAt } : {}),
  };
}

function readPayload(kek: Buffer, row: UserCredentialRow): SecretPayload {
  const aad = credentialAad(row.vaultId, row.id, row.type, bindingUrl(row));
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

function choose(
  matches: VaultCredentialRow[],
  selection: CredentialSelection | undefined,
):
  | { kind: "use"; row: VaultCredentialRow }
  | { kind: "refused"; credentialIds: string[]; reason: string } {
  const ids = matches.map((row) => row.id);
  if (matches.length === 1) {
    const only = matches[0]!;
    if (selection && selection.credentialId !== only.id)
      return {
        kind: "refused",
        credentialIds: ids,
        reason: "selection_mismatch",
      };
    return { kind: "use", row: only };
  }
  if (!selection)
    return { kind: "refused", credentialIds: ids, reason: "ambiguous" };
  const chosen = matches.find((row) => row.id === selection.credentialId);
  if (!chosen)
    return {
      kind: "refused",
      credentialIds: ids,
      reason: "selection_mismatch",
    };
  return { kind: "use", row: chosen };
}

/** The sealed part of a create or rotate: a token, or a header map with lower-cased names. */
function payloadOf(
  auth: { type: "bearer"; token: string } | { type: "headers"; headers: Record<string, string> },
): SecretPayload {
  if (auth.type === "bearer") return { token: auth.token };
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

function credentialAad(
  vaultId: string,
  credentialId: string,
  type: string,
  url: string | undefined,
): Buffer {
  return Buffer.from(
    canonical({ vaultId, credentialId, type, url }),
    "utf8",
  );
}

function requestHash(body: unknown): string {
  const { requestId: _requestId, ...rest } = body as { requestId?: string };
  return canonical(rest);
}
