/**
 * The Tenant's host model credential in plaintext: reading it to call the provider, and
 * writing back a credential the provider adapter refreshed (OAuth). Only the Model Gate holds
 * one (`gates/`; `scripts/check-boundaries.mjs` enforces it), so the loop process never reads a
 * model credential. `VaultService` seals the credential but never reads it back.
 *
 * Decryption runs after the read commits; the key is resolved before the write's transaction.
 */
import type { SessionStore } from "../store/types.js";
import type { Session } from "../tenant/context.js";
import { readAddedInputs } from "../tenant/model-setting.js";
import { encryptSecret } from "./crypto.js";
import { VaultError } from "./error.js";
import {
  activeHostCredentialRow,
  hostCredentialRowFor,
  hostCredentialRowOf,
  HOST_VAULT_ID,
  hostModelAad,
  modelBinding,
  readHostPayload,
  type HostModelSecret,
} from "./service.js";

export interface HostModelVaultOptions {
  readonly store: SessionStore;
  /** The Tenant's key-encryption key; may throw when it is missing. */
  readonly kek: () => Buffer;
}

export class HostModelVault {
  private readonly store: SessionStore;
  private readonly kek: () => Buffer;

  constructor(options: HostModelVaultOptions) {
    this.store = options.store;
    this.kek = options.kek;
  }

  /**
   * Reads the host model secret a call uses, with the inputs the operator added to catalog
   * models (protocol 12): the session's own model while its provider is connected (Host feature
   * `session-model`), else the Tenant's active one. Decrypts after the read commits.
   */
  async readHostModel(sessionId?: string): Promise<HostModelSecret | undefined> {
    const { found, addedInputs } = await this.store.tx(async (t) => {
      const session = sessionId === undefined ? undefined : await t.get<Session>("sessions", sessionId);
      return {
        found: await hostCredentialRowOf(t, session?.model),
        addedInputs: await readAddedInputs(t),
      };
    });
    if (!found) return undefined;
    const { row, binding } = found;
    // The row's own binding seals its secret; a session's model only changes what is called.
    const payload = readHostPayload(this.kek(), row, modelBinding(row));
    const credential =
      binding.authType === "oauth"
        ? { type: "oauth" as const, ...payload.oauth }
        : binding.authType === "workload"
          ? // The workload token is read from its file at each call (#496), never stored.
            { type: "workload" as const }
          : binding.authType === "host_identity"
            ? // The Host's identity is found at each call (ADR-71): only where the calls go is kept.
              { type: "host_identity" as const, ...(payload.env ? { env: payload.env } : {}) }
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
      addedInputs,
      authType: binding.authType,
      credential,
    };
  }

  /**
   * Replaces a host model's secret, keeping its binding: `provider`'s, the one the refreshed
   * credential was read for, else the active one's.
   */
  async updateHostCredential(credential: {
    type: "api_key" | "oauth";
    key?: string;
    env?: Record<string, string>;
    refresh?: string;
    access?: string;
    expires?: number;
  }, provider?: string): Promise<void> {
    const kek = this.kek();
    await this.store.tx(async (t) => {
      const row =
        provider === undefined ? await activeHostCredentialRow(t) : await hostCredentialRowFor(t, provider);
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
}
