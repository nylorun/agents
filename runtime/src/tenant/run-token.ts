/**
 * Run tokens (F5, gate trust): the ES256 JWT core mints for one advance's lease of a session.
 * It is the only credential of a model call at the gates, and the credential of a session's
 * remote MCP calls. The gates take session, turn and agent from it, never from the body, and
 * check on every call that the lease it names is still the session's (`staleRun`).
 *
 * Signed by the keys service with the Tenant's current signing key, like subject and delivery
 * tokens, and told apart from them by `typ` and `aud`. Internal: not in `openapi.json`. A token
 * lives `RUN_TOKEN_TTL_SECONDS`, no longer than a delivery token, so a key rotation never
 * revokes a live one (`signing-keys.ts`).
 *
 * ```text
 * header  { alg: ES256, typ: nylorun-run+jwt, kid }
 * claims  { iss: urn:nylorun:tenant:<id>, aud: nylorun-gates, sub: <sessionId>,
 *           trn: <turnId>, agt: <root agentId>, epc: <lease epoch>, iat, exp, jti }
 * ```
 */
import { randomUUID } from "node:crypto";
import { errors, importJWK, jwtVerify } from "jose";
import { tenantTokenIssuer } from "@nylorun/core/contracts";
import type { Keys } from "../keys/keys.js";
import type { SessionStore } from "../store/types.js";
import type { Lease } from "./context.js";
import { CLOCK_TOLERANCE_SECONDS, tokenKeyId } from "./jwt.js";

export const RUN_TOKEN_TYP = "nylorun-run+jwt";
export const RUN_TOKEN_AUD = "nylorun-gates";
/** How long a run token lives. */
export const RUN_TOKEN_TTL_SECONDS = 15 * 60;
/** The lease heartbeat re-mints a token with less than this left. */
export const RUN_TOKEN_RENEW_SECONDS = 5 * 60;
/** Allowed spread between `iat` and `exp` beyond the lifetime. */
const LIFETIME_SLACK_SECONDS = 60;

/** What a verified run token says: one lease of one session's turn. */
export interface RunClaims {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** The session's root agent: the ledger's and the agent budget's scope. */
  readonly agentId: string;
  /** The lease epoch: the fence. */
  readonly epoch: number;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** A minted run token and what it says. */
export interface RunGrant {
  readonly token: string;
  readonly claims: RunClaims;
}

/** Who mints: the Tenant's keys and id (a `TenantContext` is one). */
export interface RunTokenSigner {
  readonly keys: Keys;
  readonly config: { readonly tenantId: string };
}

/**
 * Mints the run token of `lease` over `session`'s active turn. Throws when the session has
 * no active turn: there is no run to name.
 */
export async function mintRunToken(
  signer: RunTokenSigner,
  lease: Lease,
  session: { readonly agentId: string; readonly activeTurnId: string | null },
): Promise<RunGrant> {
  const turnId = session.activeTurnId;
  if (!turnId) throw new Error(`Session ${lease.sessionId} has no active turn to mint a run token for`);
  const tenantId = signer.config.tenantId;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + RUN_TOKEN_TTL_SECONDS;
  // Signed by the keys service (F4.2): this process never holds the private key.
  const { token } = await signer.keys.sign({
    typ: RUN_TOKEN_TYP,
    claims: {
      iss: tenantTokenIssuer(tenantId),
      aud: RUN_TOKEN_AUD,
      sub: lease.sessionId,
      trn: turnId,
      agt: session.agentId,
      epc: lease.epoch,
      iat,
      exp,
      jti: randomUUID(),
    },
  });
  return {
    token,
    claims: {
      tenantId,
      sessionId: lease.sessionId,
      turnId,
      agentId: session.agentId,
      epoch: lease.epoch,
      expiresAt: exp * 1000,
    },
  };
}

/** A verified token's claims, or why it was refused (logged, never answered). */
export type RunTokenVerdict =
  | { readonly ok: true; readonly claims: RunClaims }
  | { readonly ok: false; readonly reason: string };

type PublicKey = Awaited<ReturnType<typeof importJWK>>;

/**
 * Public keys imported by key id. The key row is read on every verification, so a new key
 * (a rotation) and a revoked one apply at once; only the imported key object is kept.
 */
export type RunTokenKeyCache = Map<string, PublicKey>;

/**
 * Verifies a run token of Tenant `tenantId` against the public keys in `store`: everything a
 * forger controls (size, shape, header) is checked before any key is read, then the
 * signature, `iss`, `aud`, `typ`, lifetime and claims. A revoked key refuses even a token it
 * signed while it was live.
 */
export async function verifyRunToken(
  store: SessionStore,
  tenantId: string,
  raw: string,
  cache: RunTokenKeyCache = new Map(),
): Promise<RunTokenVerdict> {
  const refused = (reason: string): RunTokenVerdict => ({ ok: false, reason: `run_token_${reason}` });
  const checked = tokenKeyId(raw, RUN_TOKEN_TYP);
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
      audience: RUN_TOKEN_AUD,
      typ: RUN_TOKEN_TYP,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "iat", "exp", "jti"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return refused(error instanceof errors.JWTExpired ? "expired" : "invalid");
  }
  if (row.state === "revoked") return refused("key_revoked");
  const { sub, trn, agt, epc, iat, exp } = payload as {
    sub: unknown;
    trn: unknown;
    agt: unknown;
    epc: unknown;
    iat: number;
    exp: number;
  };
  if (
    typeof sub !== "string" ||
    sub === "" ||
    typeof trn !== "string" ||
    trn === "" ||
    typeof agt !== "string" ||
    agt === "" ||
    typeof epc !== "number" ||
    !Number.isSafeInteger(epc) ||
    epc < 1 ||
    exp - iat > RUN_TOKEN_TTL_SECONDS + LIFETIME_SLACK_SECONDS
  )
    return refused("claims");
  return {
    ok: true,
    claims: { tenantId, sessionId: sub, turnId: trn, agentId: agt, epoch: epc, expiresAt: exp * 1000 },
  };
}

/**
 * Why calls under `claims` are stale, or undefined while its lease is still the session's
 * (G4): the session's epoch is the token's, its active turn is the token's, and it is not
 * cancelled. One indexed read of the session row.
 */
export async function staleRun(store: SessionStore, claims: RunClaims): Promise<string | undefined> {
  const state = await store.tx((t) => t.runState(claims.sessionId));
  if (!state) return "the session is gone";
  if (state.epoch !== claims.epoch) return "another advance owns the session now";
  if (state.activeTurnId !== claims.turnId) return "the turn has ended";
  if (state.status === "cancelled") return "the turn was cancelled";
  return undefined;
}
