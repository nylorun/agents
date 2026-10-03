/**
 * Egress tokens (F7.2, D42): the ES256 JWT a pod sandbox's harness receives at join, next to its
 * host token, and presents to egress-gate as its proxy credential (`Proxy-Authorization`). It is
 * accepted by egress-gate alone and names one sandbox, one host epoch and the pod it was issued
 * to; egress-gate checks on every CONNECT that the epoch is still the sandbox's (`EgressSandboxes`).
 *
 * Signed by the keys service with the Tenant's current signing key, like run, subject and
 * delivery tokens, and told apart from them by `typ` and `aud`. Internal: not in
 * `openapi.json`. A token lives at most `EGRESS_TOKEN_MAX_TTL_SECONDS`, no longer than a delivery
 * token, so a key rotation never revokes a live one (`signing-keys.ts`).
 *
 * ```text
 * header  { alg: ES256, typ: nylorun-egress+jwt, kid }
 * claims  { iss: urn:nylorun:tenant:<id>, aud: nylorun-egress, sbx: <sandboxId>,
 *           epc: <host epoch>, pod: <pod UID>, iat, exp, jti }
 * ```
 */
import { randomUUID } from "node:crypto";
import { errors, importJWK, jwtVerify } from "jose";
import { subjectTokenIssuer } from "@nylorun/core/contracts";
import type { Keys } from "../keys/keys.js";
import type { SessionStore } from "../store/types.js";
import { CLOCK_TOLERANCE_SECONDS, tokenKeyId } from "../tenant/jwt.js";

export const EGRESS_TOKEN_TYP = "nylorun-egress+jwt";
export const EGRESS_TOKEN_AUD = "nylorun-egress";
/** How long an egress token lives by default: as long as the host token it comes with. */
export const EGRESS_TOKEN_TTL_SECONDS = 15 * 60;
/** The longest lifetime `mintEgressToken` grants and `verifyEgressToken` accepts. */
export const EGRESS_TOKEN_MAX_TTL_SECONDS = 15 * 60;
/** Allowed spread between `iat` and `exp` beyond the lifetime. */
const LIFETIME_SLACK_SECONDS = 60;

/** What a verified egress token says: one incarnation of one pod sandbox. */
export interface EgressClaims {
  readonly tenantId: string;
  readonly sandboxId: string;
  /** The sandbox's host epoch at join: the fence. */
  readonly epoch: number;
  /** The UID of the pod the token was issued to. */
  readonly podUid: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** A minted egress token and what it says. */
export interface EgressGrant {
  readonly token: string;
  readonly claims: EgressClaims;
}

/** Who mints: the Tenant's keys (a `TenantContext` is one). */
export interface EgressTokenSigner {
  readonly keys: Keys;
}

export interface EgressTokenRequest {
  readonly tenantId: string;
  readonly sandboxId: string;
  /** The host epoch the join set. */
  readonly epoch: number;
  readonly podUid: string;
  /** Seconds. Default and maximum `EGRESS_TOKEN_MAX_TTL_SECONDS`. */
  readonly ttl?: number;
}

/** Mints the egress token of one join of `podUid` to `sandboxId` at `epoch`. */
export async function mintEgressToken(
  signer: EgressTokenSigner,
  request: EgressTokenRequest,
): Promise<EgressGrant> {
  const { tenantId, sandboxId, epoch, podUid } = request;
  const ttl = request.ttl ?? EGRESS_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > EGRESS_TOKEN_MAX_TTL_SECONDS)
    throw new Error(`An egress token lives 1 to ${EGRESS_TOKEN_MAX_TTL_SECONDS} s, not ${ttl}`);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`Host epoch ${epoch} is not a positive integer`);
  if (sandboxId === "" || podUid === "") throw new Error("An egress token names a sandbox and a pod");
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  // Signed by the keys service (F4.2): this process never holds the private key.
  const { token } = await signer.keys.sign({
    typ: EGRESS_TOKEN_TYP,
    claims: {
      iss: subjectTokenIssuer(tenantId),
      aud: EGRESS_TOKEN_AUD,
      sbx: sandboxId,
      epc: epoch,
      pod: podUid,
      iat,
      exp,
      jti: randomUUID(),
    },
  });
  return { token, claims: { tenantId, sandboxId, epoch, podUid, expiresAt: exp * 1000 } };
}

/** A verified token's claims, or why it was refused (logged, never answered). */
export type EgressTokenVerdict =
  | { readonly ok: true; readonly claims: EgressClaims }
  | { readonly ok: false; readonly reason: string };

type PublicKey = Awaited<ReturnType<typeof importJWK>>;

/**
 * Public keys imported by key id. The key row is read on every verification, so a new key
 * (a rotation) and a revoked one apply at once; only the imported key object is kept.
 */
export type EgressTokenKeyCache = Map<string, PublicKey>;

/**
 * Verifies an egress token of Tenant `tenantId` against the public keys in `store`: everything
 * a forger controls (size, shape, header) is checked before any key is read, then the
 * signature, `iss`, `aud`, `typ`, lifetime and claims. A revoked key refuses even a token it
 * signed while it was live. Whether the token's epoch is still its sandbox's is the caller's
 * check (`EgressSandboxes.live`).
 */
export async function verifyEgressToken(
  store: SessionStore,
  tenantId: string,
  raw: string,
  cache: EgressTokenKeyCache = new Map(),
): Promise<EgressTokenVerdict> {
  const refused = (reason: string): EgressTokenVerdict => ({ ok: false, reason: `egress_token_${reason}` });
  const checked = tokenKeyId(raw, EGRESS_TOKEN_TYP);
  if ("refused" in checked) return refused(checked.refused);
  const { kid } = checked;
  const row = await store.tx((t) => t.signingKey(kid));
  if (!row) return refused("key_unknown");
  let key = cache.get(kid);
  if (!key) {
    key = await importJWK({ ...JSON.parse(row.publicJwk), alg: "ES256" }, "ES256");
    cache.set(kid, key);
  }
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(raw, key, {
      algorithms: ["ES256"],
      issuer: subjectTokenIssuer(tenantId),
      audience: EGRESS_TOKEN_AUD,
      typ: EGRESS_TOKEN_TYP,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iat", "exp", "jti"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return refused(error instanceof errors.JWTExpired ? "expired" : "invalid");
  }
  if (row.state === "revoked") return refused("key_revoked");
  const { sbx, epc, pod, iat, exp } = payload as {
    sbx: unknown;
    epc: unknown;
    pod: unknown;
    iat: number;
    exp: number;
  };
  if (
    typeof sbx !== "string" ||
    sbx === "" ||
    typeof pod !== "string" ||
    pod === "" ||
    typeof epc !== "number" ||
    !Number.isSafeInteger(epc) ||
    epc < 1 ||
    exp - iat > EGRESS_TOKEN_MAX_TTL_SECONDS + LIFETIME_SLACK_SECONDS
  )
    return refused("claims");
  return {
    ok: true,
    claims: { tenantId, sandboxId: sbx, epoch: epc, podUid: pod, expiresAt: exp * 1000 },
  };
}
