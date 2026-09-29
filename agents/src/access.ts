/**
 * Subject tokens and access management for app servers (Host feature `subject-tokens`), on the
 * application key. `client.tokens.create` mints a short-lived token for one signed-in person;
 * `client.access` manages the policy that decides what each role may do, the signing keys and
 * revocations. Each call checks the Host feature before sending anything.
 */
import type {
  AccessPolicy,
  CreateTokenResponse,
  Jwks,
  PublishableKey,
  SigningKeyView,
  TokenScope,
} from "@nylorun/core/contracts";
import { id, segment, type Transport } from "./http.js";

const FEATURE = "subject-tokens";

export interface CreateTokenOptions {
  /** The person the token is for, e.g. `app:42`. */
  subject: string;
  /** A role of the Tenant's access policy. */
  role: string;
  /** Narrow the role's scopes. Default: all of the role's scopes. */
  scopes?: readonly TokenScope[];
  /** Narrow the role's agents. Default: all of the role's agents. */
  agents?: readonly string[];
  /** 60 to 900 seconds, at most the policy's `maxTtlSeconds`. Default: that maximum. */
  ttlSeconds?: number;
  signal?: AbortSignal;
}

export class TokensClient {
  constructor(private readonly transport: Transport) {}

  /** Mints a subject token. Only the application key may; never acting for a subject. */
  async create(options: CreateTokenOptions): Promise<CreateTokenResponse> {
    await this.transport.requireFeature(FEATURE, options.signal);
    return this.transport.json(
      "/v1/tokens",
      "POST",
      {
        requestId: id(),
        subject: options.subject,
        role: options.role,
        ...(options.scopes ? { scopes: [...options.scopes] } : {}),
        ...(options.agents ? { agents: [...options.agents] } : {}),
        ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      },
      options.signal
    );
  }
}

export class SigningKeysClient {
  constructor(private readonly transport: Transport) {}

  async list(options: { signal?: AbortSignal } = {}): Promise<SigningKeyView[]> {
    await this.transport.requireFeature(FEATURE, options.signal);
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
   * may still verify live tokens; `force` skips that and signs those tokens out.
   */
  async rotate(
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<SigningKeyView[]> {
    await this.transport.requireFeature(FEATURE, options.signal);
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
    await this.transport.requireFeature(FEATURE, options.signal);
    return this.transport.json(
      `/v1/access/signing-keys/${segment(keyId)}/revoke`,
      "POST",
      { requestId: id() },
      options.signal
    );
  }
}

/**
 * Publishable keys (Host feature `browser-access`): shipped in a web page or an app, they name
 * the Tenant and the app, and list the origins a browser may use them from.
 */
export class PublishableKeysClient {
  constructor(private readonly transport: Transport) {}

  async list(options: { signal?: AbortSignal } = {}): Promise<PublishableKey[]> {
    await this.transport.requireFeature("browser-access", options.signal);
    const reply = await this.transport.json<{ keys: PublishableKey[] }>(
      "/v1/access/publishable-keys",
      "GET",
      undefined,
      options.signal
    );
    return reply.keys;
  }

  /**
   * A new key. `origins` are exact origins (`https://app.example.com`) or
   * `http://localhost:*`; `[]` allows native apps only.
   */
  async create(options: {
    name: string;
    origins: readonly string[];
    signal?: AbortSignal;
  }): Promise<PublishableKey> {
    await this.transport.requireFeature("browser-access", options.signal);
    return this.transport.json(
      "/v1/access/publishable-keys",
      "POST",
      { requestId: id(), name: options.name, origins: [...options.origins] },
      options.signal
    );
  }

  /** Replaces the key's origins. */
  async update(
    keyId: string,
    options: { origins: readonly string[]; signal?: AbortSignal }
  ): Promise<PublishableKey> {
    await this.transport.requireFeature("browser-access", options.signal);
    return this.transport.json(
      `/v1/access/publishable-keys/${segment(keyId)}`,
      "PUT",
      { requestId: id(), origins: [...options.origins] },
      options.signal
    );
  }

  /** Revokes the key: every request that sends it gets the opaque 404. */
  async revoke(
    keyId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<PublishableKey> {
    await this.transport.requireFeature("browser-access", options.signal);
    return this.transport.json(
      `/v1/access/publishable-keys/${segment(keyId)}`,
      "DELETE",
      undefined,
      options.signal
    );
  }
}

export class AccessClient {
  readonly signingKeys: SigningKeysClient;
  readonly publishableKeys: PublishableKeysClient;

  constructor(private readonly transport: Transport) {
    this.signingKeys = new SigningKeysClient(transport);
    this.publishableKeys = new PublishableKeysClient(transport);
  }

  async getPolicy(options: { signal?: AbortSignal } = {}): Promise<AccessPolicy> {
    await this.transport.requireFeature(FEATURE, options.signal);
    const reply = await this.transport.json<{ policy: AccessPolicy }>(
      "/v1/access/policy",
      "GET",
      undefined,
      options.signal
    );
    return reply.policy;
  }

  async putPolicy(
    policy: AccessPolicy,
    options: { signal?: AbortSignal } = {}
  ): Promise<AccessPolicy> {
    await this.transport.requireFeature(FEATURE, options.signal);
    const reply = await this.transport.json<{ policy: AccessPolicy }>(
      "/v1/access/policy",
      "PUT",
      { requestId: id(), policy },
      options.signal
    );
    return reply.policy;
  }

  /**
   * Ends every token minted so far for `subject` and its open streams. Running turns continue;
   * cancel them separately if they must stop.
   */
  async revokeSubject(
    subject: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ subject: string; epoch: number }> {
    await this.transport.requireFeature(FEATURE, options.signal);
    return this.transport.json(
      "/v1/access/revocations",
      "POST",
      { requestId: id(), subject },
      options.signal
    );
  }

  /** The public keys that verify the Tenant's subject tokens. */
  async jwks(options: { signal?: AbortSignal } = {}): Promise<Jwks> {
    await this.transport.requireFeature(FEATURE, options.signal);
    return this.transport.json("/v1/access/jwks", "GET", undefined, options.signal);
  }
}
