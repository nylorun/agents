/**
 * The keys seam (blueprint §14, F4.2): everything that needs the vault key. Vault writes that
 * touch a secret (writing an Environment's secret, setting and selecting the host model;
 * rotation and selection decrypt the old secret first; sealing a fork's copies of its source's
 * secrets, which the fork's transaction then inserts) and all token signing (capability
 * links, run and host tokens, signing-key rotation) run here, whole, so the process that calls them never
 * holds the key or a private signing key.
 *
 * A tool preview (R2b C12, `previewMcp`) runs here too: it sends an Environment's credential to
 * the server it lists, so the process that reads the plaintext makes the request.
 *
 * Two implementations: `inProcessKeys` (embedding, the ephemeral Runtime, tests, and the gates
 * service itself, which serves the HTTP routes with it), and `httpKeys` (`client.ts`), the
 * runtime container's client of the `keys` service in the gateway.
 */
import { EgressAuthority } from "./egress-ca.js";
import { SignJWT } from "jose";
import type {
  AgentSecretView,
  HostModelView,
  McpPreview,
  McpPreviewRequest,
  PutAgentSecretRequest,
  PutHostModelRequest,
  SelectHostModelRequest,
  SigningKeyView,
} from "@nylorun/core/contracts";
import { previewMcpServer } from "../mcp/preview.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import type { SessionStore } from "../store/types.js";
import type { OutboundPolicy } from "../tenant/outbound.js";
import { signingKeyView, type SigningKeys } from "../tenant/signing-keys.js";
import type { SealedSecretCopies, VaultService } from "../vault/service.js";

/** One JWT to sign: its `typ` and every claim, `iss`, `aud`, `sub`, `iat`, `exp` and `jti` included. */
export interface SignRequest {
  readonly typ: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface Signed {
  readonly token: string;
  /** The signing key's id, the token's `kid`. */
  readonly keyId: string;
}

export interface Keys {
  /** `PUT /v1/agents/{id}/secrets/{name}` (`VaultService.putEnvironmentSecret`). */
  putEnvironmentSecret(
    environmentId: string,
    name: string,
    body: PutAgentSecretRequest,
    actor: string,
  ): Promise<AgentSecretView>;
  putHostModel(body: PutHostModelRequest): Promise<HostModelView>;
  selectHostModel(body: SelectHostModelRequest): Promise<HostModelView>;
  /**
   * Environment `from`'s secrets sealed again for a fork's new vault `vaultId`, limited to
   * `slots` when given (`VaultService.sealEnvironmentSecretCopies`, Q15). Writes nothing: the
   * fork's transaction inserts the copies; call it before that transaction opens. `null`, not
   * `undefined`, crosses the wire.
   */
  sealEnvironmentSecretCopies(
    from: string,
    vaultId: string,
    slots: Readonly<Record<string, Record<string, unknown>>> | null,
  ): Promise<SealedSecretCopies>;
  /** Signs with the current key, creating the Tenant's keys if it has none. */
  sign(request: SignRequest): Promise<Signed>;
  /** Rotates the signing keys (`SigningKeys.rotate`); 409 while the previous key may verify live tokens. */
  rotateSigningKeys(request: { maxTtlSeconds: number; force: boolean }): Promise<SigningKeyView[]>;
  /** Creates the current and standby keys when the Tenant has none. */
  ensureSigningKeys(): Promise<void>;
  /**
   * Lists a remote MCP server's tools with the Environment's credential for its URL
   * (R2b C12, `mcp/preview.ts`); never calls a tool.
   */
  previewMcp(body: McpPreviewRequest): Promise<McpPreview>;
  /** The egress CA's certificate (PEM), creating the CA when the Tenant has none (R2c, D50). */
  egressCa(): Promise<string>;
  /**
   * A short-lived leaf for `host` and the caller's P-256 public key (SPKI PEM), signed by the
   * egress CA (R2c). The leaf's private key never reaches keys; the CA's never leaves it.
   */
  signEgressLeaf(host: string, publicKey: string): Promise<string>;
}

/** The operations, by the name the HTTP route carries. */
export const KEYS_OPERATIONS = [
  "putEnvironmentSecret",
  "putHostModel",
  "selectHostModel",
  "sealEnvironmentSecretCopies",
  "sign",
  "rotateSigningKeys",
  "ensureSigningKeys",
  "previewMcp",
  "egressCa",
  "signEgressLeaf",
] as const satisfies readonly (keyof Keys)[];

export type KeysOperation = (typeof KEYS_OPERATIONS)[number];

export interface InProcessKeysOptions {
  readonly store: SessionStore;
  /** Its vault key is `kek`. */
  readonly vault: VaultService;
  readonly signingKeys: SigningKeys;
  /** The vault key. */
  readonly kek: () => Buffer;
  /** How a tool preview reaches the server (`TenantConfig.delivery`). Default: no limits. */
  readonly policy?: OutboundPolicy;
}

export function inProcessKeys(options: InProcessKeysOptions): Keys {
  const { store, vault, signingKeys, kek } = options;
  const egress = new EgressAuthority(store, kek);
  return {
    putEnvironmentSecret: (environmentId, name, body, actor) =>
      vault.putEnvironmentSecret(environmentId, name, body, actor),
    putHostModel: (body) => vault.putHostModel(body),
    selectHostModel: (body) => vault.selectHostModel(body),
    sealEnvironmentSecretCopies: (from, vaultId, slots) => vault.sealEnvironmentSecretCopies(from, vaultId, slots),
    async sign(request) {
      const key = kek();
      const row = await store.tx((t) => signingKeys.ensure(t, key));
      const signer = await signingKeys.privateKey(row, key);
      const token = await new SignJWT({ ...request.claims })
        .setProtectedHeader({ alg: "ES256", typ: request.typ, kid: signer.id })
        .sign(signer.key);
      return { token, keyId: signer.id };
    },
    async rotateSigningKeys(request) {
      const key = kek();
      const rows = await store.tx((t) =>
        signingKeys.rotate(t, key, request.maxTtlSeconds, request.force),
      );
      return rows.map(signingKeyView);
    },
    async ensureSigningKeys() {
      const key = kek();
      await store.tx((t) => signingKeys.ensure(t, key));
    },
    previewMcp: async (body) =>
      previewMcpServer(body, {
        vault,
        policy: options.policy ?? {},
        limits: await store.tx((t) => readRuntimeLimits(t)),
      }),
    egressCa: () => egress.certificate(),
    signEgressLeaf: (host, publicKey) => egress.signLeaf(host, publicKey),
  };
}
