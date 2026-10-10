/**
 * The Tenant's host model credential in plaintext: reading it to call the provider, and
 * writing back a credential the provider adapter refreshed (OAuth). Only the Model Gate holds
 * one (`gates/`; `scripts/check-boundaries.mjs` enforces it), so the loop process never reads a
 * model credential. `VaultService` seals the credential but never reads it back.
 *
 * Decryption runs after the read commits; the key is resolved before the write's transaction.
 */
import type { SessionStore } from "../store/types.js";
import { encryptSecret } from "./crypto.js";
import { VaultError } from "./error.js";
import {
  activeHostCredentialRow,
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

  /** Reads the active host model secret. Decrypts after the read commits. */
  async readHostModel(): Promise<HostModelSecret | undefined> {
    const row = await this.store.tx((t) => activeHostCredentialRow(t));
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

  /** Replaces the active host model's secret, keeping its binding. */
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
      const row = await activeHostCredentialRow(t);
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
