/**
 * Host and egress tokens (F7.2, D42): the ES256 JWTs a pod sandbox's engine holds once its
 * join token is exchanged (`sandbox/join.ts`). Both name one sandbox and one host epoch; a
 * join, a relaunch, a loss, an expiry, a stop or a reset moves the epoch, and a token of an
 * older one is refused. Signed by the keys service with the Tenant's current signing key,
 * like run tokens, and told apart from them and from each other by `typ` and `aud`:
 *
 * ```text
 * host    { alg: ES256, typ: nylorun-host+jwt, kid }
 *         { iss: urn:nylorun:tenant:<id>, aud: nylorun-harness-api, sub: <sandboxId>,
 *           sbx: <sandboxId>, epc: <host epoch>, pod: <pod UID>, iat, exp, jti }
 * egress  { alg: ES256, typ: nylorun-egress+jwt, kid }
 *         { iss: urn:nylorun:tenant:<id>, aud: nylorun-egress,
 *           sbx: <sandboxId>, epc: <host epoch>, pod: <pod UID>, iat, exp, jti }
 * ```
 *
 * The host token is accepted only by the Harness API listener (a connection serving that one
 * sandbox, and `host.renew`); the egress token only by egress-gate, as the proxy credential
 * (`Proxy-Authorization`). Neither is a bearer anywhere else: the Tenant API's bearer check
 * accepts trusted issuers' and delivery tokens only, and the gates run tokens only.
 *
 * Verification reads the key row on every call (a revoked key refuses at once) and, with
 * `currentHost`, the sandbox's row (one indexed read): the epoch must be the sandbox's, the
 * pod its pod, and the sandbox neither lost, expired nor deleted.
 */
import { randomUUID } from "node:crypto";
import { errors, importJWK, jwtVerify } from "jose";
import { tenantTokenIssuer } from "@nylorun/core/contracts";
import type { Keys } from "../keys/keys.js";
import type { SessionStore } from "../store/types.js";
import { CLOCK_TOLERANCE_SECONDS, tokenKeyId } from "./jwt.js";

export const HOST_TOKEN_TYP = "nylorun-host+jwt";
export const HOST_TOKEN_AUD = "nylorun-harness-api";
export const EGRESS_TOKEN_TYP = "nylorun-egress+jwt";
export const EGRESS_TOKEN_AUD = "nylorun-egress";
/** How long a host or egress token lives. The engine renews them before. */
export const HOST_TOKEN_TTL_SECONDS = 15 * 60;
const LIFETIME_SLACK_SECONDS = 60;

/** What a verified host or egress token says. */
export interface HostClaims {
  readonly tenantId: string;
  readonly sandboxId: string;
  /** The host epoch: the fence. */
  readonly epoch: number;
  /** The UID of the pod the token was minted for. */
  readonly podUid: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** A host token and the egress token minted with it. */
export interface HostGrant {
  readonly hostToken: string;
  readonly egressToken: string;
  readonly claims: HostClaims;
}

export interface HostTokenSigner {
  readonly keys: Keys;
  readonly config: { readonly tenantId: string };
}

/** One egress token to mint: one pod of one sandbox at one host epoch. */
export interface EgressTokenRequest {
  readonly tenantId: string;
  readonly sandboxId: string;
  /** The host epoch the join set. */
  readonly epoch: number;
  readonly podUid: string;
  /** Seconds. Default and maximum `HOST_TOKEN_TTL_SECONDS`. */
  readonly ttl?: number;
}

/**
 * Mints an egress token (the only path that does): the proxy credential egress-gate accepts,
 * with egress-gate's claims (no `sub`). `mintHostTokens` mints one with every host token.
 */
export async function mintEgressToken(
  signer: { readonly keys: Keys },
  request: EgressTokenRequest,
): Promise<{ readonly token: string; readonly claims: HostClaims }> {
  const { tenantId, sandboxId, epoch, podUid } = request;
  const ttl = request.ttl ?? HOST_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > HOST_TOKEN_TTL_SECONDS)
    throw new Error(`An egress token lives 1 to ${HOST_TOKEN_TTL_SECONDS} s, not ${ttl}`);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`Host epoch ${epoch} is not a positive integer`);
  if (sandboxId === "" || podUid === "") throw new Error("An egress token names a sandbox and a pod");
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  const { token } = await signer.keys.sign({
    typ: EGRESS_TOKEN_TYP,
    claims: {
      iss: tenantTokenIssuer(tenantId),
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

/** Mints the host and egress tokens of `sandboxId`'s pod `podUid` at host epoch `epoch`. */
export async function mintHostTokens(
  signer: HostTokenSigner,
  host: { readonly sandboxId: string; readonly epoch: number; readonly podUid: string },
): Promise<HostGrant> {
  const tenantId = signer.config.tenantId;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + HOST_TOKEN_TTL_SECONDS;
  const [hostToken, egress] = await Promise.all([
    signer.keys.sign({
      typ: HOST_TOKEN_TYP,
      claims: {
        iss: tenantTokenIssuer(tenantId),
        aud: HOST_TOKEN_AUD,
        sub: host.sandboxId,
        sbx: host.sandboxId,
        epc: host.epoch,
        pod: host.podUid,
        iat,
        exp,
        jti: randomUUID(),
      },
    }),
    mintEgressToken(signer, { tenantId, ...host }),
  ]);
  return {
    hostToken: hostToken.token,
    egressToken: egress.token,
    claims: {
      tenantId,
      sandboxId: host.sandboxId,
      epoch: host.epoch,
      podUid: host.podUid,
      expiresAt: exp * 1000,
    },
  };
}

/** A verified token's claims, or why it was refused (logged, never answered). */
export type HostTokenVerdict =
  | { readonly ok: true; readonly claims: HostClaims }
  | { readonly ok: false; readonly reason: string };

type PublicKey = Awaited<ReturnType<typeof importJWK>>;
/** Public keys imported by key id; the key row is still read on every verification. */
export type HostTokenKeyCache = Map<string, PublicKey>;

const KINDS = {
  host: { typ: HOST_TOKEN_TYP, aud: HOST_TOKEN_AUD },
  egress: { typ: EGRESS_TOKEN_TYP, aud: EGRESS_TOKEN_AUD },
} as const;

/**
 * Verifies a host (`kind: "host"`) or egress (`kind: "egress"`) token of Tenant `tenantId`:
 * shape and header before any key is read, then the signature, `iss`, `aud`, `typ`, lifetime
 * and claims. It does not read the sandbox: `currentHost` does.
 */
export async function verifyHostToken(
  store: SessionStore,
  tenantId: string,
  raw: string,
  kind: keyof typeof KINDS,
  cache: HostTokenKeyCache = new Map(),
): Promise<HostTokenVerdict> {
  const refused = (reason: string): HostTokenVerdict => ({ ok: false, reason: `${kind}_token_${reason}` });
  const { typ, aud } = KINDS[kind];
  const checked = tokenKeyId(raw, typ);
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
      issuer: tenantTokenIssuer(tenantId),
      audience: aud,
      typ,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iat", "exp", "jti"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return refused(error instanceof errors.JWTExpired ? "expired" : "invalid");
  }
  if (row.state === "revoked") return refused("key_revoked");
  const { sub, sbx, epc, pod, iat, exp } = payload as Record<string, unknown> & {
    iat: number;
    exp: number;
  };
  if (
    typeof sbx !== "string" ||
    sbx === "" ||
    (kind === "host" && sub !== sbx) ||
    typeof pod !== "string" ||
    pod === "" ||
    typeof epc !== "number" ||
    !Number.isSafeInteger(epc) ||
    epc < 1 ||
    exp - iat > HOST_TOKEN_TTL_SECONDS + LIFETIME_SLACK_SECONDS
  )
    return refused("claims");
  return {
    ok: true,
    claims: { tenantId, sandboxId: sbx, epoch: epc, podUid: pod, expiresAt: exp * 1000 },
  };
}

/**
 * Why a host's claims are stale, or undefined while they are its sandbox's current host: the
 * sandbox exists as a pod sandbox, is not deleted, lost or expired, and its epoch and pod are
 * the token's. One indexed read of the sandbox's row.
 */
export async function staleHost(store: SessionStore, claims: HostClaims): Promise<string | undefined> {
  const row = await store.tx((t) => t.sandboxResource(claims.sandboxId));
  const pod = row?.pod;
  if (!row || row.kind !== "pod" || !pod) return "the sandbox is gone";
  if (pod.desired === "deleted") return "the sandbox was deleted";
  if (pod.observed === "lost") return "the sandbox was lost";
  if (pod.observed === "expired") return "the sandbox expired";
  if (pod.hostEpoch !== claims.epoch) return "another host holds the sandbox now";
  if (pod.podUid !== claims.podUid) return "the token is another pod's";
  return undefined;
}
