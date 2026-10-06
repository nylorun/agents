/**
 * The Runtime API as an OAuth 2.1 resource server (protocol 9, Host feature `resource-server`).
 * Nylorun is never the authorization server: the operator's identity providers are, listed in
 * the identity file, and this module only says so in the standard places.
 *
 * - `GET /.well-known/oauth-protected-resource` (RFC 9728): the resource (`NYLORUN_PUBLIC_URL`,
 *   else the origin the request reached), every trusted issuer in the file's order, and the
 *   scopes their tokens may carry. Without trusted issuers there is none: the Runtime takes no
 *   OAuth tokens.
 * - `WWW-Authenticate: Bearer` challenges (OAuth 2.1 §5.3, RFC 6750): a missing credential
 *   carries no error code; a rejected one `error="invalid_token"`; a token missing a route's
 *   scope `error="insufficient_scope"` with the scopes that would do. On the Runtime API they
 *   point at the metadata (`resource_metadata`); the Management API takes management keys only
 *   and is no OAuth resource, so its challenge is a bare `Bearer`.
 */
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { TOKEN_SCOPES } from "@nylorun/core/contracts";
import { HttpError } from "./http.js";
import type { TrustedIssuers } from "./issuers.js";

/** Where the protected resource metadata is served (RFC 9728 §3). */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** What the metadata and the challenges are made of: `TenantConfig`'s fields of the same names. */
export interface ResourceServerConfig {
  /** The URL clients reach the Runtime API at (`NYLORUN_PUBLIC_URL`, no trailing slash). */
  readonly publicUrl?: string;
  /** The identity file's trusted issuers. */
  readonly issuers?: TrustedIssuers;
}

/** RFC 9728 protected resource metadata. */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly ["header"];
  readonly resource_name: string;
}

/** The origin `incoming` reached, as `@hono/node-server` builds a request's URL. */
function requestOrigin(incoming: IncomingMessage): string {
  const scheme = (incoming.socket as TLSSocket | undefined)?.encrypted ? "https" : "http";
  return `${scheme}://${incoming.headers.host ?? "localhost"}`;
}

/** This Runtime API's resource identifier: the public URL, else the request's origin. */
function resourceOf(config: ResourceServerConfig, incoming: IncomingMessage): string {
  return config.publicUrl ?? requestOrigin(incoming);
}

/** The metadata, or undefined when the Runtime trusts no issuer. */
export function protectedResourceMetadata(
  config: ResourceServerConfig,
  incoming: IncomingMessage,
): ProtectedResourceMetadata | undefined {
  const issuers = config.issuers?.issuers ?? [];
  if (issuers.length === 0) return undefined;
  // `studio` signs a person in to Studio; no Runtime API route asks for it.
  const granted = new Set(issuers.flatMap((issuer) => issuer.config.allowedScopes));
  return {
    resource: resourceOf(config, incoming),
    authorization_servers: issuers.map((issuer) => issuer.config.issuer),
    scopes_supported: TOKEN_SCOPES.filter((scope) => granted.has(scope)),
    bearer_methods_supported: ["header"],
    resource_name: "Nylorun Runtime API",
  };
}

/**
 * The metadata's URL for a challenge's `resource_metadata`, or undefined when there is none.
 * A resource with a path has its metadata at the origin, the path after the well-known part.
 */
export function protectedResourceMetadataUrl(
  config: ResourceServerConfig,
  incoming: IncomingMessage,
): string | undefined {
  if ((config.issuers?.issuers.length ?? 0) === 0) return undefined;
  const url = new URL(resourceOf(config, incoming));
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}${PROTECTED_RESOURCE_PATH}${path}`;
}

interface Challenge {
  readonly error?: "invalid_token" | "insufficient_scope";
  readonly description?: string;
  readonly scope?: string;
  readonly resourceMetadata?: string | undefined;
}

/** A `WWW-Authenticate: Bearer` value. Every parameter value is plain ASCII without quotes. */
export function bearerChallenge(challenge: Challenge = {}): string {
  const params: string[] = [];
  if (challenge.error) params.push(`error="${challenge.error}"`);
  if (challenge.description) params.push(`error_description="${challenge.description}"`);
  if (challenge.scope) params.push(`scope="${challenge.scope}"`);
  if (challenge.resourceMetadata) params.push(`resource_metadata="${challenge.resourceMetadata}"`);
  return params.length === 0 ? "Bearer" : `Bearer ${params.join(", ")}`;
}

/**
 * The `401` for a request without a usable credential: `credential_required` when it sent
 * none (no error code, OAuth 2.1 §5.3.2), `credential_invalid` when the Tenant refused the one
 * it sent. The reason is the Runtime's log's, never the client's.
 */
export function failCredential(
  kind: "required" | "invalid",
  resourceMetadata: string | undefined,
): never {
  if (kind === "required")
    throw new HttpError(
      401,
      "A bearer credential is required",
      { code: "credential_required" },
      { "www-authenticate": bearerChallenge({ resourceMetadata }) },
    );
  throw new HttpError(
    401,
    "The credential is not valid here",
    { code: "credential_invalid" },
    { "www-authenticate": bearerChallenge({ error: "invalid_token", resourceMetadata }) },
  );
}
