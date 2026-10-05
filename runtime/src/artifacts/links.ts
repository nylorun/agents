/**
 * Capability links (protocol 6): a short-lived URL that opens one artifact version with no
 * other credential, for UIs, `<img>` tags and sharing. The token in the path is an ES256 JWT
 * (`typ: nylorun-artifact+jwt`) signed with the Tenant's current signing key by the keys
 * service, like delivery tokens: `sub` is the artifact, `ver` the version, `aud`
 * `nylorun-artifact`, and it lives at most `ARTIFACT_LINK_MAX_TTL_SECONDS` (`TOKEN_TTL_MAX_SECONDS`,
 * so a key rotation never revokes a live link). A link opens nothing once its artifact
 * is deleted. A folder's link (F8.2) opens its zip, or with a `path` claim one of its files.
 */
import { randomUUID } from "node:crypto";
import { errors, jwtVerify } from "jose";
import {
  ARTIFACT_LINK_DEFAULT_TTL_SECONDS,
  ARTIFACT_LINK_MAX_TTL_SECONDS,
  ARTIFACT_LINK_TOKEN_TYPE,
  tenantTokenIssuer,
} from "@nylorun/core/contracts";
import { isArtifactId } from "@nylorun/core/compatibility";
import type { TenantContext } from "../tenant/context.js";
import { failOpaque, HttpError } from "../tenant/http.js";
import { CLOCK_TOLERANCE_SECONDS, tokenKeyId } from "../tenant/jwt.js";

/** The audience of every capability link. */
export const ARTIFACT_LINK_AUDIENCE = "nylorun-artifact";
/** Where a capability link is served: `GET /v1/artifact-links/<token>`. */
export const ARTIFACT_LINK_PATH = "/v1/artifact-links";

export interface MintedArtifactLink {
  path: string;
  artifactId: string;
  version: number;
  /** The folder's file the link opens. */
  file?: string;
  expiresAt: string;
}

export async function mintArtifactLink(
  ctx: TenantContext,
  link: { artifactId: string; version: number; expiresIn?: number; file?: string },
): Promise<MintedArtifactLink> {
  const ttl = Math.max(
    1,
    Math.min(
      Math.floor(link.expiresIn ?? ARTIFACT_LINK_DEFAULT_TTL_SECONDS),
      ARTIFACT_LINK_MAX_TTL_SECONDS,
    ),
  );
  const iat = Math.floor(Date.now() / 1000);
  // Signed by the keys service (F4.2): this process never holds the private key.
  const { token } = await ctx.keys.sign({
    typ: ARTIFACT_LINK_TOKEN_TYPE,
    claims: {
      iss: tenantTokenIssuer(ctx.config.tenantId),
      aud: ARTIFACT_LINK_AUDIENCE,
      sub: link.artifactId,
      ver: link.version,
      ...(link.file === undefined ? {} : { path: link.file }),
      iat,
      exp: iat + ttl,
      jti: randomUUID(),
    },
  });
  return {
    path: `${ARTIFACT_LINK_PATH}/${token}`,
    artifactId: link.artifactId,
    version: link.version,
    ...(link.file === undefined ? {} : { file: link.file }),
    expiresAt: new Date((iat + ttl) * 1000).toISOString(),
  };
}

/**
 * The artifact version a capability link opens. An expired link, or one whose key was revoked,
 * is `401 token_expired`; anything else that does not verify is the opaque 404.
 */
export async function verifyArtifactLink(
  ctx: TenantContext,
  raw: string,
): Promise<{ artifactId: string; version: number; file?: string }> {
  const checked = tokenKeyId(raw, ARTIFACT_LINK_TOKEN_TYPE);
  if ("refused" in checked) return refused(ctx, `artifact_link_${checked.refused}`);
  const row = await ctx.store.tx((t) => t.signingKey(checked.kid));
  if (!row) return refused(ctx, "artifact_link_key_unknown");
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(raw, await ctx.signingKeys.publicKey(row), {
      algorithms: ["ES256"],
      issuer: tenantTokenIssuer(ctx.config.tenantId),
      audience: ARTIFACT_LINK_AUDIENCE,
      typ: ARTIFACT_LINK_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "aud", "iat", "exp", "jti"],
    });
    claims = verified.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof errors.JWTExpired) expired(ctx, "artifact_link_expired");
    return refused(ctx, "artifact_link_invalid");
  }
  if (row.state === "revoked") expired(ctx, "artifact_link_key_revoked");
  const { sub, ver, path, exp, iat } = claims as {
    sub: unknown;
    ver: unknown;
    path: unknown;
    exp: number;
    iat: number;
  };
  if (
    !isArtifactId(sub) ||
    typeof ver !== "number" ||
    !Number.isInteger(ver) ||
    ver < 1 ||
    (path !== undefined && (typeof path !== "string" || path === "")) ||
    exp - iat > ARTIFACT_LINK_MAX_TTL_SECONDS
  )
    return refused(ctx, "artifact_link_claims");
  return { artifactId: sub, version: ver, ...(typeof path === "string" ? { file: path } : {}) };
}

function refused(ctx: TenantContext, reason: string): never {
  ctx.config.logger.warn("credential rejected", { reason });
  return failOpaque();
}

function expired(ctx: TenantContext, reason: string): never {
  ctx.config.logger.warn("artifact link refused", { reason });
  throw new HttpError(401, "The link has expired", { code: "token_expired" });
}
