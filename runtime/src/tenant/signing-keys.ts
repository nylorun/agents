/**
 * Tenant signing keys for subject tokens. Each key is an ES256 pair: the public JWK is stored
 * as is, the PKCS#8 private key is sealed with the vault KEK (AAD bound to the Tenant and key
 * id), like a credential.
 *
 * States: `standby` (published, not used yet), `current` (signs), `previous` (verifies only),
 * `revoked`. The first use creates `current` and `standby`. Rotating moves standby → current →
 * previous → revoked and makes a new standby; it is refused while the key it would revoke may
 * still verify live tokens, so a rotation never signs anyone out (`force` skips that guard).
 *
 * Key states are read from the database on every use, so a revocation applies at once on
 * every node. Only imported key objects are cached: public keys by id (immutable) and the
 * current private key.
 */
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  importPKCS8,
} from "jose";
import {
  newSigningKeyId,
  SIGNING_KEY_ID_PATTERN,
} from "@nylorun/core/compatibility";
import type {
  PublicJwk,
  SigningKeyView,
} from "@nylorun/core/contracts";
import type { SigningKeyRow, Tx } from "../store/types.js";
import { DELIVERY_TOKEN_MAX_TTL_SECONDS } from "@nylorun/core/contracts";
import { decryptSecret, encryptSecret } from "../vault/crypto.js";
import { fail } from "./http.js";

const ALG = "ES256";
/** Grace added to the longest token lifetime before a previous key may be revoked. */
const ROTATION_GRACE_MS = 60_000;

type KeyLike = Awaited<ReturnType<typeof importJWK>>;

export interface SigningKeysOptions {
  tenantId: string;
  /** The vault KEK, created on first use. Resolve it before opening a transaction. */
  kek(): Buffer;
}

export interface CurrentKey {
  readonly id: string;
  readonly key: KeyLike;
}

export class SigningKeys {
  private readonly publicKeys = new Map<string, KeyLike>();
  private current: CurrentKey | undefined;

  constructor(private readonly options: SigningKeysOptions) {}

  kek(): Buffer {
    return this.options.kek();
  }

  private aad(id: string): Buffer {
    return Buffer.from(`nylorun.signing-key:${this.options.tenantId}:${id}`);
  }

  /** A new sealed key row in `state`. In-memory crypto only; safe inside a transaction. */
  private async create(
    kek: Buffer,
    state: "standby" | "current",
    now: string
  ): Promise<SigningKeyRow> {
    const id = newSigningKeyId();
    const pair = await generateKeyPair(ALG, { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    const pkcs8 = await exportPKCS8(pair.privateKey);
    const sealed = encryptSecret(kek, this.aad(id), Buffer.from(pkcs8, "utf8"));
    return {
      id,
      state,
      alg: ALG,
      publicJwk: JSON.stringify({
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
      }),
      createdAt: now,
      activatedAt: state === "current" ? now : null,
      retiredAt: null,
      revokedAt: null,
      kekId: sealed.kekId,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      wrappedDek: sealed.wrappedDek,
    };
  }

  /** The current key row, creating `current` and `standby` if the Tenant has none. */
  async ensure(t: Tx, kek: Buffer): Promise<SigningKeyRow> {
    const live = await t.signingKeys(["standby", "current"]);
    const now = new Date().toISOString();
    let current = live.find((row) => row.state === "current");
    if (!current) {
      const standby = live.find((row) => row.state === "standby");
      if (standby) {
        await t.setSigningKeyState(standby.id, "standby", "current", now);
        current = { ...standby, state: "current", activatedAt: now };
      } else {
        current = await this.create(kek, "current", now);
        await t.insertSigningKey(current);
      }
    }
    if (!live.some((row) => row.state === "standby" && row.id !== current!.id))
      await t.insertSigningKey(await this.create(kek, "standby", now));
    return current;
  }

  /** The private key of `row` (the current key), imported once per key id. */
  async privateKey(row: SigningKeyRow, kek: Buffer): Promise<CurrentKey> {
    if (this.current?.id === row.id) return this.current;
    const pkcs8 = decryptSecret(
      kek,
      this.aad(row.id),
      Buffer.from(row.nonce),
      Buffer.from(row.ciphertext),
      Buffer.from(row.wrappedDek),
      row.kekId
    ).toString("utf8");
    const key = await importPKCS8(pkcs8, ALG);
    this.current = { id: row.id, key };
    return this.current;
  }

  /** The public key of `row`, imported once per key id. */
  async publicKey(row: SigningKeyRow): Promise<KeyLike> {
    const cached = this.publicKeys.get(row.id);
    if (cached) return cached;
    const key = await importJWK({ ...JSON.parse(row.publicJwk), alg: ALG }, ALG);
    this.publicKeys.set(row.id, key);
    return key;
  }

  /**
   * Rotates: previous → revoked, current → previous, standby → current, new standby. Refused
   * with 409 while the previous key may still verify live tokens (retired less than the
   * longest token lifetime, `maxTtlSeconds` or a delivery token's, plus a minute ago), unless
   * `force`.
   */
  async rotate(
    t: Tx,
    kek: Buffer,
    maxTtlSeconds: number,
    force: boolean
  ): Promise<SigningKeyRow[]> {
    await this.ensure(t, kek);
    const now = new Date();
    const at = now.toISOString();
    const [previous] = await t.signingKeys(["previous"]);
    if (previous && !force) {
      const retired = Date.parse(previous.retiredAt ?? previous.createdAt);
      // Delivery tokens may outlive the policy's subject tokens.
      const longest = Math.max(maxTtlSeconds, DELIVERY_TOKEN_MAX_TTL_SECONDS);
      const until = retired + longest * 1000 + ROTATION_GRACE_MS;
      if (until > now.getTime())
        fail(409, "The previous key may still verify live tokens", {
          code: "request_rejected",
          details: { retryAfterSeconds: Math.ceil((until - now.getTime()) / 1000) },
        });
    }
    if (previous) await t.setSigningKeyState(previous.id, "previous", "revoked", at);
    const [current] = await t.signingKeys(["current"]);
    const [standby] = await t.signingKeys(["standby"]);
    if (current) await t.setSigningKeyState(current.id, "current", "previous", at);
    if (standby) await t.setSigningKeyState(standby.id, "standby", "current", at);
    else await t.insertSigningKey(await this.create(kek, "current", at));
    await t.insertSigningKey(await this.create(kek, "standby", at));
    return t.signingKeys();
  }

  /** Revokes a `previous` or `standby` key. The current key must be rotated first. */
  async revoke(t: Tx, id: string): Promise<SigningKeyRow> {
    const row = SIGNING_KEY_ID_PATTERN.test(id)
      ? await t.signingKey(id)
      : undefined;
    if (!row) return fail(404, "Signing key not found");
    if (row.state === "revoked") return row;
    if (row.state === "current")
      return fail(409, "Rotate before revoking the current key");
    const at = new Date().toISOString();
    await t.setSigningKeyState(row.id, row.state, "revoked", at);
    return { ...row, state: "revoked", revokedAt: at };
  }
}

export function publicJwk(row: SigningKeyRow): PublicJwk {
  return { ...JSON.parse(row.publicJwk), kid: row.id, alg: ALG, use: "sig" };
}

export function signingKeyView(row: SigningKeyRow): SigningKeyView {
  return {
    id: row.id,
    state: row.state,
    alg: row.alg,
    publicKey: publicJwk(row),
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    revokedAt: row.revokedAt,
  };
}
