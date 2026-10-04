/**
 * The Tenant's signing keys and public keys, for app servers on the application key. The
 * Runtime signs delivery tokens (Action endpoints) and capability links with them; an Action
 * endpoint verifies delivery tokens with the public keys (`jwks`).
 */
import type { Jwks, SigningKeyView } from "@nylorun/core/contracts";
import { id, segment, type Transport } from "./http.js";

export class SigningKeysClient {
  constructor(private readonly transport: Transport) {}

  async list(options: { signal?: AbortSignal } = {}): Promise<SigningKeyView[]> {
    const reply = await this.transport.json<{ keys: SigningKeyView[] }>(
      "/v1/access/signing-keys",
      "GET",
      undefined,
      options.signal
    );
    return reply.keys;
  }

  /**
   * standby → current → previous → revoked, and a new standby. Refused while the previous key
   * may still verify live tokens; `force` skips that and ends those tokens.
   */
  async rotate(
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<SigningKeyView[]> {
    const reply = await this.transport.json<{ keys: SigningKeyView[] }>(
      "/v1/access/signing-keys/rotate",
      "POST",
      { requestId: id(), ...(options.force ? { force: true } : {}) },
      options.signal
    );
    return reply.keys;
  }

  /** Revokes a previous or standby key; the current key must be rotated first. */
  async revoke(
    keyId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<SigningKeyView> {
    return this.transport.json(
      `/v1/access/signing-keys/${segment(keyId)}/revoke`,
      "POST",
      { requestId: id() },
      options.signal
    );
  }
}

export class AccessClient {
  readonly signingKeys: SigningKeysClient;

  constructor(private readonly transport: Transport) {
    this.signingKeys = new SigningKeysClient(transport);
  }

  /** The public keys that verify the Tenant's delivery tokens. */
  async jwks(options: { signal?: AbortSignal } = {}): Promise<Jwks> {
    return this.transport.json("/v1/access/jwks", "GET", undefined, options.signal);
  }
}
