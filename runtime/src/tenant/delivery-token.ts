/**
 * Delivery tokens (design: Action endpoints §8.1): the ES256 JWT the Runtime signs, with the
 * Tenant's current signing key, for one delivery of one Action, or for a ping. It travels in
 * `Nylorun-Signature` on the request to the Action endpoint, which verifies it with the
 * Tenant's public keys, and comes back as the bearer of that Action's callbacks (a background
 * result, heartbeats, sandbox tools).
 *
 * A token lives at most `DELIVERY_TOKEN_MAX_TTL_SECONDS`, the subject-token maximum, and key
 * rotation waits at least that long before it revokes the previous key
 * (`signing-keys.ts`), so a rotation never revokes a live token.
 */
import { createHash, randomUUID } from "node:crypto";
import { errors, jwtVerify, SignJWT } from "jose";
import {
  DELIVERY_TOKEN_MAX_TTL_SECONDS,
  DELIVERY_TOKEN_TYPE,
  subjectTokenIssuer,
} from "@nylorun/core/contracts";
import type { AuthScope, TenantContext } from "./context.js";
import { failOpaque, HttpError } from "./http.js";
import { CLOCK_TOLERANCE_SECONDS, tokenKeyId } from "./jwt.js";

/** What a delivery token is for: one delivery of an Action, or a ping. */
export type DeliveryTokenFor =
  | { kind: "action"; actionId: string; agentId: string; generation: number }
  | { kind: "ping"; agentId: string };

export interface MintedDeliveryToken {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  tokenId: string;
  keyId: string;
}

/** The request scope of a verified delivery token (`AuthScope` kind `delivery`). */
export type DeliveryScope = Extract<AuthScope, { kind: "delivery" }>;

/** base64url SHA-256 of a request body: the token's `bdy` claim. */
export function bodyHash(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("base64url");
}

/**
 * Signs a token for `delivery`, for the endpoint at `audience`, covering `body`. `ttlSeconds`
 * is capped at `DELIVERY_TOKEN_MAX_TTL_SECONDS`.
 */
export async function mintDeliveryToken(
  ctx: TenantContext,
  options: {
    for: DeliveryTokenFor;
    audience: string;
    body: string | Uint8Array;
    ttlSeconds: number;
  },
): Promise<MintedDeliveryToken> {
  const kek = ctx.signingKeys.kek();
  const row = await ctx.store.tx((t) => ctx.signingKeys.ensure(t, kek));
  const signer = await ctx.signingKeys.privateKey(row, kek);
  const ttl = Math.max(1, Math.min(Math.floor(options.ttlSeconds), DELIVERY_TOKEN_MAX_TTL_SECONDS));
  const iat = Math.floor(Date.now() / 1000);
  const tokenId = randomUUID();
  const delivery = options.for;
  const token = await new SignJWT({
    agt: delivery.agentId,
    gen: delivery.kind === "action" ? delivery.generation : 0,
    bdy: bodyHash(options.body),
  })
    .setProtectedHeader({ alg: "ES256", typ: DELIVERY_TOKEN_TYPE, kid: signer.id })
    .setIssuer(subjectTokenIssuer(ctx.config.tenantId))
    .setAudience(options.audience)
    .setSubject(delivery.kind === "action" ? delivery.actionId : "ping")
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setJti(tokenId)
    .sign(signer.key);
  return { token, expiresAt: (iat + ttl) * 1000, tokenId, keyId: signer.id };
}

/**
 * Verifies a delivery token presented as a bearer. Answers `401 token_expired` for an expired
 * token or a revoked key, and the opaque 404 for everything else, a ping token included: only
 * an Action's token reaches its callbacks. Whether the Action is still being delivered at the
 * token's generation is checked where the Action is read (`auth.ts` `scoped`).
 */
export async function verifyDeliveryToken(
  ctx: TenantContext,
  raw: string,
): Promise<DeliveryScope> {
  const checked = tokenKeyId(raw, DELIVERY_TOKEN_TYPE);
  if ("refused" in checked) return refused(ctx, `delivery_token_${checked.refused}`);
  const { kid } = checked;
  const row = await ctx.store.tx((t) => t.signingKey(kid));
  if (!row) return refused(ctx, "delivery_token_key_unknown");
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(raw, await ctx.signingKeys.publicKey(row), {
      algorithms: ["ES256"],
      issuer: subjectTokenIssuer(ctx.config.tenantId),
      typ: DELIVERY_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "aud", "iat", "exp", "jti"],
    });
    claims = verified.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof errors.JWTExpired) expired(ctx, "delivery_token_expired");
    return refused(ctx, "delivery_token_invalid");
  }
  if (row.state === "revoked") expired(ctx, "delivery_token_key_revoked");
  const { sub, agt, gen, exp, iat, jti } = claims as {
    sub: string;
    agt: unknown;
    gen: unknown;
    exp: number;
    iat: number;
    jti: string;
  };
  if (
    sub === "ping" ||
    typeof agt !== "string" ||
    typeof gen !== "number" ||
    !Number.isInteger(gen) ||
    gen < 1 ||
    exp - iat > DELIVERY_TOKEN_MAX_TTL_SECONDS
  )
    return refused(ctx, "delivery_token_claims");
  return {
    kind: "delivery",
    actionId: sub,
    agentId: agt,
    generation: gen,
    expiresAt: exp * 1000,
    tokenId: jti,
    keyId: kid,
  };
}

function refused(ctx: TenantContext, reason: string): never {
  ctx.config.logger.warn("credential rejected", { reason });
  return failOpaque();
}

function expired(ctx: TenantContext, reason: string): never {
  ctx.config.logger.warn("delivery token refused", { reason });
  throw new HttpError(
    401,
    "The delivery token has expired or its key was revoked",
    { code: "token_expired" },
    { "www-authenticate": 'Bearer error="invalid_token"' },
  );
}
