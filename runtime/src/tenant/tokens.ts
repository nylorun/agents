/**
 * Subject tokens (Host feature `subject-tokens`): ES256 JWTs minted by `POST /v1/tokens` with
 * an application key, for one subject and one role of the access policy.
 *
 * Verification order matters: everything a forger controls is checked before any signature
 * work, and nothing but the signature-verified cases reveals more than the opaque 404.
 * Expired tokens, a stale revocation epoch, a revoked key or a removed role answer
 * `401 token_expired`, so clients always react the same way: get a new token.
 */
import { randomUUID } from "node:crypto";
import { decodeProtectedHeader, errors, jwtVerify, SignJWT } from "jose";
import { SIGNING_KEY_ID_PATTERN } from "@nylorun/core/compatibility";
import {
  isSubject,
  SUBJECT_TOKEN_AUDIENCE,
  SUBJECT_TOKEN_TYPE,
  subjectTokenIssuer,
  TOKEN_SCOPES,
  TOKEN_TTL_MIN_SECONDS,
  type CreateTokenRequest,
  type CreateTokenResponse,
  type SubjectTokenClaims,
  type TokenScope,
} from "@nylorun/core/contracts";
import { agentAllowed, readPolicy, resolveRole } from "./access-policy.js";
import type { AuthScope, TenantContext } from "./context.js";
import { fail, failOpaque, HttpError } from "./http.js";

const MAX_TOKEN_BYTES = 4096;
const CLOCK_TOLERANCE_SECONDS = 30;
/** Allowed spread between `iat` and `exp` beyond the policy's longest lifetime. */
const LIFETIME_SLACK_SECONDS = 60;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const FORBIDDEN_HEADERS = ["jku", "jwk", "x5u", "x5c", "x5t", "crit"];

/** True when `bearer` has the shape of a JWT; application and executor keys never do. */
export function looksLikeToken(bearer: string): boolean {
  return JWT_SHAPE.test(bearer);
}

/** The 401 every "get a new token" case answers. The reason is logged, never returned. */
function expired(ctx: TenantContext, reason: string, jti?: string): never {
  ctx.config.logger.warn("subject token refused", {
    reason,
    ...(jti ? { jti } : {}),
  });
  throw new HttpError(
    401,
    "The subject token has expired or was revoked",
    { code: "token_expired" },
    { "www-authenticate": 'Bearer error="invalid_token"' }
  );
}

function rejected(ctx: TenantContext, reason: string): never {
  ctx.config.logger.warn("credential rejected", { reason });
  return failOpaque();
}

export async function mintToken(
  ctx: TenantContext,
  body: CreateTokenRequest
): Promise<CreateTokenResponse> {
  const kek = ctx.signingKeys.kek();
  const tenantId = ctx.config.tenantId;
  const { access, epoch, row, ttl } = await ctx.store.tx(async (t) => {
    const policy = await readPolicy(t);
    const role = Object.hasOwn(policy.roles, body.role)
      ? policy.roles[body.role]
      : undefined;
    if (!role)
      return fail(400, `Role ${body.role} is not in the access policy`, {
        code: "invalid_request",
      });
    const scopes = body.scopes ?? role.scopes;
    const outside = scopes.filter((scope) => !role.scopes.includes(scope));
    if (outside.length > 0)
      fail(400, `Role ${body.role} does not allow ${outside.join(", ")}`, {
        code: "invalid_request",
      });
    if (body.agents && role.agents !== "*") {
      const allowed = new Set(role.agents);
      const extra = body.agents.filter((agent) => !allowed.has(agent));
      if (extra.length > 0)
        fail(400, `Role ${body.role} does not allow agent ${extra.join(", ")}`, {
          code: "invalid_request",
        });
    }
    const maxTtl = policy.tokens.maxTtlSeconds;
    const ttl = Math.min(body.ttlSeconds ?? maxTtl, maxTtl);
    if (ttl < TOKEN_TTL_MIN_SECONDS)
      fail(400, `ttlSeconds must be at least ${TOKEN_TTL_MIN_SECONDS}`);
    return {
      access: resolveRole(policy, body.role, scopes, body.agents)!,
      epoch: await t.subjectEpoch(body.subject),
      row: await ctx.signingKeys.ensure(t, kek),
      ttl,
    };
  });
  const signer = await ctx.signingKeys.privateKey(row, kek);
  const iat = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const scopes = [...access.scopes];
  const claims: Omit<SubjectTokenClaims, "iss" | "aud" | "sub" | "iat" | "exp" | "jti"> = {
    tnt: tenantId,
    role: body.role,
    scp: scopes.join(" "),
    ...(body.agents ? { agt: [...body.agents] } : {}),
    epc: epoch,
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: SUBJECT_TOKEN_TYPE, kid: signer.id })
    .setIssuer(subjectTokenIssuer(tenantId))
    .setAudience(SUBJECT_TOKEN_AUDIENCE)
    .setSubject(body.subject)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setJti(jti)
    .sign(signer.key);
  ctx.config.logger.info("subject token minted", {
    jti,
    kid: signer.id,
    role: body.role,
  });
  return {
    token,
    expiresAt: new Date((iat + ttl) * 1000).toISOString(),
    subject: body.subject,
    role: body.role,
    scopes,
    agents: access.agents === "*" ? "*" : [...access.agents],
    keyId: signer.id,
  };
}

export type TokenScopeAuth = Extract<AuthScope, { kind: "token" }>;

/**
 * Verifies a subject token. Returns the request's scope, answers `401 token_expired` for
 * the cases a new token fixes, and the opaque 404 for everything else.
 */
export async function verifySubjectToken(
  ctx: TenantContext,
  raw: string
): Promise<TokenScopeAuth> {
  if (Buffer.byteLength(raw) > MAX_TOKEN_BYTES || !JWT_SHAPE.test(raw))
    return rejected(ctx, "token_malformed");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(raw);
  } catch {
    return rejected(ctx, "token_malformed");
  }
  if (
    header.alg !== "ES256" ||
    header.typ !== SUBJECT_TOKEN_TYPE ||
    typeof header.kid !== "string" ||
    !SIGNING_KEY_ID_PATTERN.test(header.kid) ||
    FORBIDDEN_HEADERS.some((name) => name in header)
  )
    return rejected(ctx, "token_header");
  const kid = header.kid;
  const { row, policy } = await ctx.store.tx(async (t) => ({
    row: await t.signingKey(kid),
    policy: await readPolicy(t),
  }));
  if (!row) return rejected(ctx, "token_key_unknown");
  const tenantId = ctx.config.tenantId;
  let claims: SubjectTokenClaims;
  try {
    const verified = await jwtVerify(raw, await ctx.signingKeys.publicKey(row), {
      algorithms: ["ES256"],
      issuer: subjectTokenIssuer(tenantId),
      audience: SUBJECT_TOKEN_AUDIENCE,
      typ: SUBJECT_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "iat", "exp", "jti"],
    });
    claims = verified.payload as unknown as SubjectTokenClaims;
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      // The signature was valid; only now may the answer differ from a forgery.
      return expired(ctx, "expired");
    }
    return rejected(ctx, "token_invalid");
  }
  // The key was revoked after it signed: a new token uses the current key.
  if (row.state === "revoked") return expired(ctx, "key_revoked", claims.jti);
  const scopeNames =
    typeof claims.scp === "string" ? claims.scp.split(" ").filter(Boolean) : [];
  if (
    claims.tnt !== tenantId ||
    !isSubject(claims.sub) ||
    typeof claims.role !== "string" ||
    typeof claims.epc !== "number" ||
    !Number.isInteger(claims.epc) ||
    claims.exp - claims.iat >
      policy.tokens.maxTtlSeconds + LIFETIME_SLACK_SECONDS ||
    scopeNames.some((name) => !(TOKEN_SCOPES as readonly string[]).includes(name)) ||
    (claims.agt !== undefined &&
      (!Array.isArray(claims.agt) ||
        claims.agt.some((agent) => typeof agent !== "string")))
  )
    return rejected(ctx, "token_claims");
  const epoch = await ctx.store.tx((t) => t.subjectEpoch(claims.sub));
  if (claims.epc !== epoch) return expired(ctx, "revoked", claims.jti);
  const access = resolveRole(
    policy,
    claims.role,
    scopeNames as TokenScope[],
    claims.agt
  );
  if (!access) return expired(ctx, "role_removed", claims.jti);
  if (access.scopes.size === 0) return expired(ctx, "role_narrowed", claims.jti);
  return {
    kind: "token",
    subject: claims.sub,
    scopes: access.scopes,
    agents: access.agents,
    role: access.role,
    ...(access.limits ? { limits: access.limits } : {}),
    epoch,
    expiresAt: claims.exp * 1000,
    tokenId: claims.jti,
    keyId: kid,
  };
}

/** True when a token caller may reach `agentId`. Other callers always may. */
export function mayUseAgent(scope: AuthScope, agentId: string): boolean {
  return scope.kind !== "token" || agentAllowed(scope.agents, agentId);
}
