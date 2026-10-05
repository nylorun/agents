/**
 * The Tenant's public keys, which verify the delivery tokens (Action endpoints) and capability
 * links it signs. Listing, rotating and revoking signing keys is the Management API's
 * (`admin.signingKeys` in `@nylorun/admin`, protocol 8).
 */
import type { Jwks } from "@nylorun/core/contracts";
import type { Transport } from "./http.js";

export class AccessClient {
  constructor(private readonly transport: Transport) {}

  /** The public keys that verify the Tenant's delivery tokens. */
  async jwks(options: { signal?: AbortSignal } = {}): Promise<Jwks> {
    return this.transport.json("/v1/access/jwks", "GET", undefined, options.signal);
  }
}
