/**
 * Egress tokens (F7.2, D42), as egress-gate sees them: the proxy credential a pod's engine
 * receives at join with its host token (`sandbox/join.ts`) and presents in `Proxy-Authorization`.
 * Minted and verified by `tenant/host-token.ts`, the one place host and egress tokens are made:
 *
 * ```text
 * header  { alg: ES256, typ: nylorun-egress+jwt, kid }
 * claims  { iss: urn:nylorun:tenant:<id>, aud: nylorun-egress, sbx: <sandboxId>,
 *           epc: <host epoch>, pod: <pod UID>, iat, exp, jti }
 * ```
 *
 * Verification checks shape and header before any key is read, then the signature, `iss`,
 * `aud`, `typ`, lifetime and claims; whether the epoch is still the sandbox's is egress-gate's
 * check (`EgressSandboxes.live`).
 */
import type { SessionStore } from "../store/types.js";
import {
  EGRESS_TOKEN_AUD,
  EGRESS_TOKEN_TYP,
  HOST_TOKEN_TTL_SECONDS,
  mintEgressToken,
  verifyHostToken,
  type EgressTokenRequest,
  type HostClaims,
  type HostTokenKeyCache,
  type HostTokenVerdict,
} from "../tenant/host-token.js";

export { EGRESS_TOKEN_AUD, EGRESS_TOKEN_TYP, mintEgressToken, type EgressTokenRequest };
/** The longest lifetime an egress token has: a host token's. */
export const EGRESS_TOKEN_MAX_TTL_SECONDS = HOST_TOKEN_TTL_SECONDS;
export type EgressClaims = HostClaims;
export type EgressTokenVerdict = HostTokenVerdict;
/** Public keys imported by key id; the key row is still read on every verification. */
export type EgressTokenKeyCache = HostTokenKeyCache;

/** Verifies an egress token of Tenant `tenantId`; refusal reasons are `egress_token_*`. */
export function verifyEgressToken(
  store: SessionStore,
  tenantId: string,
  raw: string,
  cache: EgressTokenKeyCache = new Map(),
): Promise<EgressTokenVerdict> {
  return verifyHostToken(store, tenantId, raw, "egress", cache);
}
