/**
 * The Runtime vault (docs/design/runtime/vault.md, architecture §12.9):
 * administer vaults and credentials, attach them to sessions, and authorize
 * outbound MCP calls. Storage is the async Session Store (`store/types.ts`);
 * this module holds no SQL.
 *
 * ## Public surface
 *
 * ```ts
 * new VaultService({ store: SessionStore, kek: () => Buffer, fetch: typeof fetch })
 *
 * // Administration: each opens its own transaction and writes its audit rows
 * // in that transaction. Creates and rotations replay by idempotency key.
 * createVault(body: CreateVaultRequest): Promise<VaultInfo>
 * listVaults(ownerUserId: string): Promise<VaultInfo[]>
 * getVault(id: string): Promise<VaultInfo>
 * assertOwner(id: string, ownerUserId: string): Promise<void>
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
 * // Use: opens its own transactions; never call it inside one.
 * authorize(input: { sessionId; vaultIds; credentialSelections; url; serverName? }): Promise<AuthorizeResult>
 *
 * // Host model credential: each opens its own transaction.
 * getHostModel(): Promise<HostModelView>
 * listHostProviders(): Promise<{ providers: HostModelProviderInfo[] }>
 * putHostModel(body: PutHostModelRequest): Promise<HostModelView>
 * selectHostModel(body: SelectHostModelRequest): Promise<HostModelView>
 * readHostModel(): Promise<HostModelSecret | undefined>
 * updateHostCredential(credential): Promise<void>
 * ```
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
 *   so the plaintext never enters a transaction. An OAuth refresh calls the
 *   token endpoint outside any transaction, then stores the rotated secret and
 *   its `refresh` audit row in one follow-up transaction (re-reading the
 *   current row there). The `use`/`approved` audit row is written in a final
 *   transaction before the header is returned: if that write fails,
 *   `authorize` rejects and no header leaves the vault, so every approved use
 *   has an audit row. Unreadable ciphertext and refresh failures are audited
 *   in their own transaction before the refusal is returned.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  CreateCredentialRequest,
  CreateVaultRequest,
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
import {
  decryptSecret,
  encryptSecret,
  VaultCryptoError,
} from "./crypto.js";
import { VaultError } from "./error.js";
import { hostModelCatalog } from "../model/catalog.js";
import { normalizeVaultUrl } from "./url.js";

const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const HOST_VAULT_ID = "host";
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
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  clientId?: string;
  tokenEndpointAuth?: "none" | "client_secret_basic" | "client_secret_post";
};

type UserCredentialRow = VaultCredentialRow & { type: "bearer" | "oauth" };

export type AuthorizeResult =
  | {
      status: "unauthenticated";
      url: string;
      headers: Record<string, string>;
    }
  | {
      status: "authorized";
      url: string;
      headers: { authorization: string };
    }
  | {
      status: "refused";
      url: string;
      credentialIds: string[];
      reason: string;
    };

type Refused = Extract<AuthorizeResult, { status: "refused" }>;

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
  /** Used only for OAuth refresh, always outside a transaction. */
  fetch: typeof fetch;
  /** How long a token endpoint may take to answer a refresh. Default 30 s. */
  refreshTimeoutMs?: number;
}

type Refreshed = { status: "ok"; payload: SecretPayload } | Refused;

export class VaultService {
  private readonly store: SessionStore;
  private readonly kek: () => Buffer;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshTimeoutMs: number;
  /** Refreshes in progress by credential id: concurrent uses share one. */
  private readonly refreshing = new Map<string, Promise<Refreshed>>();

  constructor(options: VaultServiceOptions) {
    this.store = options.store;
    this.kek = options.kek;
    this.fetchImpl = options.fetch;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
  }

  // --- administration --------------------------------------------------------

  async createVault(body: CreateVaultRequest): Promise<VaultInfo> {
    return this.store.tx((t) =>
      this.replay(t, `create-vault:${body.idempotencyKey}`, body, async () => {
        const row: VaultRow = {
          id: randomUUID(),
          name: body.name,
          ownerUserId: body.ownerUserId,
          metadataJson: body.metadata ? JSON.stringify(body.metadata) : null,
          createdAt: new Date().toISOString(),
          scope: "user",
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

  async listVaults(ownerUserId: string): Promise<VaultInfo[]> {
    return this.store.tx(async (t) =>
      (await t.vaultsByOwner(ownerUserId)).map(vaultInfoOf),
    );
  }

  async getVault(id: string): Promise<VaultInfo> {
    return this.store.tx((t) => this.vaultInfo(t, id));
  }

  /** Another owner's vault, or the host vault, is the same 404 as a missing one. */
  async assertOwner(id: string, ownerUserId: string): Promise<void> {
    await this.store.tx(async (t) => {
      const row = await t.getVault(id);
      if (!row || row.scope !== "user" || row.ownerUserId !== ownerUserId)
        throw new VaultError(404, "Vault not found");
    });
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
          const sealed = encryptSecret(
            kek,
            credentialAad(vaultId, id, type, url),
            Buffer.from(JSON.stringify(payloadFromCreate(body)), "utf8"),
          );
          const row: UserCredentialRow = {
            id,
            vaultId,
            name: body.name,
            type,
            bindingJson: JSON.stringify({ url }),
            expiresAt: expiresFromCreate(body),
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
          const next: SecretPayload = { ...readPayload(kek, row) };
          let expiresAt = row.expiresAt;
          if (body.auth.type === "bearer") next.token = body.auth.token;
          else {
            next.accessToken = body.auth.accessToken;
            expiresAt =
              body.auth.expiresAt === undefined || body.auth.expiresAt === null
                ? null
                : requireTimestamp(body.auth.expiresAt);
          }
          const updated = await this.writePayload(
            t,
            kek,
            row,
            next,
            expiresAt,
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
      async (t): Promise<{ result: AuthorizeResult } | { row: UserCredentialRow }> => {
        for (const id of input.vaultIds) {
          if (await t.getVault(id)) continue;
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
        return { row: chosen.row as UserCredentialRow };
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
    if (row.type === "oauth" && dueForRefresh(row.expiresAt)) {
      const refreshed = await this.refreshShared(kek, row, payload, input.sessionId, url);
      if (refreshed.status === "refused") return refreshed;
      payload = refreshed.payload;
    }
    const token = row.type === "bearer" ? payload.token : payload.accessToken;
    if (!token) {
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
    return {
      status: "authorized",
      url,
      headers: { authorization: `Bearer ${token}` },
    };
  }

  // --- host model ----------------------------------------------------------------

  async getHostModel(): Promise<HostModelView> {
    return this.store.tx((t) => this.hostModelView(t));
  }

  async listHostProviders(): Promise<{ providers: HostModelProviderInfo[] }> {
    return this.store.tx(async (t) => {
      const active = await this.activeProviderId(t);
      const catalog = new Map(
        hostModelCatalog().providers.map((provider) => [provider.id, provider.name]),
      );
      const providers = (await this.hostModelRows(t)).map((row) => {
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
        const row = await this.hostCredentialRowFor(t, body.provider);
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

  /** Reads the active host model secret. Decrypts after the read commits. */
  async readHostModel(): Promise<HostModelSecret | undefined> {
    const row = await this.store.tx((t) => this.activeHostCredentialRow(t));
    if (!row) return undefined;
    const binding = modelBinding(row);
    const payload = readHostPayload(this.kek(), row, binding);
    const credential =
      binding.authType === "oauth"
        ? { type: "oauth" as const, ...payload.oauth }
        : {
            type: "api_key" as const,
            key: payload.apiKey,
            ...(payload.env ? { env: payload.env } : {}),
          };
    return {
      provider: binding.provider,
      model: binding.model,
      ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
      ...(binding.settings ? { settings: binding.settings } : {}),
      authType: binding.authType,
      credential,
    };
  }

  async updateHostCredential(credential: {
    type: "api_key" | "oauth";
    key?: string;
    env?: Record<string, string>;
    refresh?: string;
    access?: string;
    expires?: number;
  }): Promise<void> {
    const kek = this.kek();
    await this.store.tx(async (t) => {
      const row = await this.activeHostCredentialRow(t);
      if (!row) throw new VaultError(404, "Model provider is not configured");
      const binding = modelBinding(row);
      const payload =
        credential.type === "oauth"
          ? { oauth: credential }
          : {
              apiKey: credential.key,
              ...(credential.env ? { env: credential.env } : {}),
            };
      const sealed = encryptSecret(
        kek,
        hostModelAad(binding.provider, binding.model),
        Buffer.from(JSON.stringify(payload), "utf8"),
      );
      await t.updateCredential(HOST_VAULT_ID, row.id, {
        type: "model",
        bindingJson: JSON.stringify({ ...binding, authType: credential.type }),
        ...sealed,
        rotatedAt: new Date().toISOString(),
      });
    });
  }

  // --- internals -----------------------------------------------------------------

  /** Calls the token endpoint outside any transaction, then stores the result. */
  /**
   * Refreshes an OAuth grant once for every concurrent use in this process. A rotating refresh
   * token is valid once, so two refreshes with it would fail the second, or make the provider
   * revoke the grant.
   */
  private refreshShared(
    kek: Buffer,
    row: UserCredentialRow,
    payload: SecretPayload,
    sessionId: string,
    url: string,
  ): Promise<Refreshed> {
    let pending = this.refreshing.get(row.id);
    if (!pending) {
      pending = this.refreshLatest(kek, row, payload, sessionId, url).finally(() =>
        this.refreshing.delete(row.id),
      );
      this.refreshing.set(row.id, pending);
    }
    return pending;
  }

  /** Uses a token another process refreshed instead of refreshing again, before and after. */
  private async refreshLatest(
    kek: Buffer,
    row: UserCredentialRow,
    payload: SecretPayload,
    sessionId: string,
    url: string,
  ): Promise<Refreshed> {
    const before = await this.rotatedSince(kek, row);
    if (before) return { status: "ok", payload: before };
    const refreshed = await this.refresh(kek, row, payload, sessionId, url);
    if (refreshed.status === "ok") return refreshed;
    // The loser of a race with another process fails with the spent refresh token.
    const after = await this.rotatedSince(kek, row);
    return after ? { status: "ok", payload: after } : refreshed;
  }

  /** The credential's payload when it was rotated after `row` was read and is not due. */
  private async rotatedSince(
    kek: Buffer,
    row: UserCredentialRow,
  ): Promise<SecretPayload | undefined> {
    const current = await this.store.tx((t) => t.getCredential(row.id));
    if (!current || current.vaultId !== row.vaultId || !isUserCredential(current)) return undefined;
    if (current.rotatedAt === row.rotatedAt || dueForRefresh(current.expiresAt)) return undefined;
    try {
      return readPayload(kek, current);
    } catch {
      return undefined;
    }
  }

  private async refresh(
    kek: Buffer,
    row: UserCredentialRow,
    payload: SecretPayload,
    sessionId: string,
    url: string,
  ): Promise<Refreshed> {
    const failRefresh = async (): Promise<Refused> => {
      await this.store.tx((t) =>
        this.audit(t, {
          actor: "host",
          action: "refresh",
          vaultId: row.vaultId,
          credentialId: row.id,
          sessionId,
          target: payload.tokenEndpoint,
          outcome: "refresh_failed",
        }),
      );
      return {
        status: "refused",
        url,
        credentialIds: [row.id],
        reason: "refresh_failed",
      };
    };
    if (!payload.refreshToken || !payload.tokenEndpoint || !payload.clientId)
      return failRefresh();
    let next: SecretPayload;
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: payload.refreshToken,
        client_id: payload.clientId,
      });
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (payload.tokenEndpointAuth === "client_secret_post") {
        if (!payload.clientSecret) return failRefresh();
        body.set("client_secret", payload.clientSecret);
      }
      if (payload.tokenEndpointAuth === "client_secret_basic") {
        if (!payload.clientSecret) return failRefresh();
        const encoded = Buffer.from(
          `${encodeURIComponent(payload.clientId)}:${encodeURIComponent(payload.clientSecret)}`,
        ).toString("base64");
        headers.authorization = `Basic ${encoded}`;
      }
      const response = await this.fetchImpl(payload.tokenEndpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(this.refreshTimeoutMs),
      });
      if (!response.ok) return failRefresh();
      const json = (await response.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
        refresh_token?: unknown;
      };
      if (typeof json.access_token !== "string" || json.access_token.length === 0)
        return failRefresh();
      next = {
        ...payload,
        accessToken: json.access_token,
        refreshToken:
          typeof json.refresh_token === "string"
            ? json.refresh_token
            : payload.refreshToken,
      };
      const expiresAt =
        typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
          ? new Date(Date.now() + json.expires_in * 1000).toISOString()
          : null;
      await this.store.tx(async (t) => {
        const current = await this.credentialRow(t, row.vaultId, row.id);
        await this.writePayload(
          t,
          kek,
          current,
          next,
          expiresAt,
          new Date().toISOString(),
        );
        await this.audit(t, {
          actor: "host",
          action: "refresh",
          vaultId: row.vaultId,
          credentialId: row.id,
          sessionId,
          target: payload.tokenEndpoint,
          outcome: "approved",
        });
      });
    } catch {
      return failRefresh();
    }
    return { status: "ok", payload: next };
  }

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

  /** Re-seals a user credential's payload and returns the updated row. */
  private async writePayload(
    t: Tx,
    kek: Buffer,
    row: UserCredentialRow,
    payload: SecretPayload,
    expiresAt: string | null,
    rotatedAt: string,
  ): Promise<UserCredentialRow> {
    const sealed = encryptSecret(
      kek,
      credentialAad(row.vaultId, row.id, row.type, bindingUrl(row)),
      Buffer.from(JSON.stringify(payload), "utf8"),
    );
    const patch = { expiresAt, rotatedAt, ...sealed };
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
    const row = await this.activeHostCredentialRow(t);
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

  private async hostModelRows(t: Tx): Promise<VaultCredentialRow[]> {
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

  private async hostCredentialRowFor(
    t: Tx,
    provider: string,
  ): Promise<VaultCredentialRow | undefined> {
    const preferred = hostModelCredentialId(provider);
    const rows = await this.hostModelRows(t);
    return (
      rows.find((row) => row.id === preferred) ??
      rows.find((row) => modelBinding(row).provider === provider)
    );
  }

  private async activeHostCredentialRow(
    t: Tx,
  ): Promise<VaultCredentialRow | undefined> {
    const active = await this.activeProviderId(t);
    if (!active) return undefined;
    return this.hostCredentialRowFor(t, active);
  }

  private async activeProviderId(t: Tx): Promise<string | undefined> {
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
          if (await this.hostCredentialRowFor(t, activeProvider))
            return activeProvider;
        } catch {
          /* An invalid provider id falls through, as before. */
        }
      }
    }
    const rows = await this.hostModelRows(t);
    if (rows.length === 0) return undefined;
    if (rows.length === 1) return modelBinding(rows[0]!).provider;
    const legacy = rows.find((row) => row.id === HOST_MODEL_ID);
    if (legacy) return modelBinding(legacy).provider;
    return modelBinding(rows[0]!).provider;
  }

  private async setActiveProvider(t: Tx, provider: string): Promise<void> {
    await this.ensureHostVault(t);
    await t.updateVaultMetadata(
      HOST_VAULT_ID,
      JSON.stringify({ activeProvider: provider }),
    );
  }

  private async deleteHostProviderRows(t: Tx, provider: string): Promise<void> {
    const ids = (await this.hostModelRows(t))
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

function credentialInfoOf(row: UserCredentialRow): CredentialInfo {
  return {
    id: row.id,
    vaultId: row.vaultId,
    name: row.name,
    type: row.type,
    binding: JSON.parse(row.bindingJson) as { url: string },
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
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

function readHostPayload(
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

function dueForRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - Date.now() <= REFRESH_SKEW_MS;
}

function payloadFromCreate(body: CreateCredentialRequest): SecretPayload {
  if (body.auth.type === "bearer") return { token: body.auth.token };
  const refresh = body.auth.refresh;
  const tokenEndpoint = refresh
    ? normalizeVaultUrl(refresh.tokenEndpoint, { httpsOnly: true })
    : undefined;
  if (body.auth.expiresAt) requireTimestamp(body.auth.expiresAt);
  return {
    accessToken: body.auth.accessToken,
    ...(refresh
      ? {
          refreshToken: refresh.refreshToken,
          tokenEndpoint,
          clientId: refresh.clientId,
          tokenEndpointAuth: refresh.tokenEndpointAuth.type,
          ...(refresh.tokenEndpointAuth.type === "none"
            ? {}
            : { clientSecret: refresh.tokenEndpointAuth.clientSecret }),
        }
      : {}),
  };
}

function expiresFromCreate(body: CreateCredentialRequest): string | null {
  if (body.auth.type !== "oauth" || !body.auth.expiresAt) return null;
  return requireTimestamp(body.auth.expiresAt);
}

function requireTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)))
    throw new VaultError(400, "Credential expiry is invalid");
  return new Date(Date.parse(value)).toISOString();
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

function modelBinding(row: VaultCredentialRow): ModelBinding {
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

function hostModelAad(provider: string, model: string): Buffer {
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
