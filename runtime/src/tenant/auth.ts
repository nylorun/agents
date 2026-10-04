/**
 * Tenant request authentication and authorization: a bearer token resolves to an application
 * principal, a trusted issuer's token or a delivery token; anything else is the opaque 404
 * (D5). An application principal may act for a subject (`Nylorun-Subject`, `Nylorun-Scopes`);
 * an issuer token names its subject itself. `requireScopes` limits them to the routes their
 * scopes allow, decided from the route alone.
 *
 * Browsers: a request with `Origin` may carry an issuer token (CORS is the operator's proxy's),
 * never an application key or a delivery token, which are server secrets.
 */
import type { IncomingMessage } from "node:http";
import {
  SCOPES_HEADER,
  SUBJECT_HEADER,
} from "@nylorun/core/compatibility";
import {
  DELIVERY_TOKEN_TYPE,
  parseSubjectHeaders,
  type Action,
  type SubjectScope,
} from "@nylorun/core/contracts";
import { hashToken } from "../core/bearer.js";
import type { AuthScope, SessionAccess, TenantContext } from "./context.js";
import { fail, failOpaque } from "./http.js";
import { verifyDeliveryToken } from "./delivery-token.js";
import { verifyIssuerToken } from "./issuers.js";
import { looksLikeToken, tokenType } from "./jwt.js";

const SUBJECT_INVALID = { code: "subject_invalid" } as const;

/** One header's value, or `undefined`; a header sent twice is refused. */
function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct?.[name.toLowerCase()];
  if (!values) {
    const raw = request.headers[name.toLowerCase()];
    return Array.isArray(raw) ? fail(400, `${name} must be sent once`, SUBJECT_INVALID) : raw;
  }
  if (values.length > 1) return fail(400, `${name} must be sent once`, SUBJECT_INVALID);
  return values[0];
}

export async function authenticate(
  ctx: TenantContext,
  request: IncomingMessage
): Promise<AuthScope> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !header?.startsWith("Bearer ")) {
    ctx.config.logger.warn("credential rejected", {
      reason: "missing_bearer",
    });
    return failOpaque();
  }
  if (looksLikeToken(token) && tokenType(token) === DELIVERY_TOKEN_TYPE) {
    // Delivery tokens come back from the application's server, never from a browser.
    if (request.headers.origin !== undefined)
      fail(403, "Delivery tokens are not accepted from browsers", { code: "origin_rejected" });
    const scope = await verifyDeliveryToken(ctx, token);
    if (
      singleHeader(request, SUBJECT_HEADER) !== undefined ||
      singleHeader(request, SCOPES_HEADER) !== undefined
    )
      fail(403, "A delivery token cannot act for a subject");
    return scope;
  }
  // A trusted issuer's token (Host feature `trusted-issuers`), from a server or a browser: its
  // unverified `iss` names an issuer of the identity file, and only that issuer verifies it.
  const issuer = ctx.config.issuers?.claimed(token);
  if (issuer) {
    const scope = await verifyIssuerToken(ctx, issuer, token);
    if (
      singleHeader(request, SUBJECT_HEADER) !== undefined ||
      singleHeader(request, SCOPES_HEADER) !== undefined
    )
      fail(403, "An issuer token cannot act for another subject");
    return scope;
  }
  // Any other JWT: no issuer of this Host signed it (subject tokens are gone, protocol 7).
  if (looksLikeToken(token)) {
    ctx.config.logger.warn("credential rejected", { reason: "token_unknown_issuer" });
    return failOpaque();
  }
  // Application keys never come from a browser or a shipped app: refused before they are even
  // looked up.
  if (request.headers.origin !== undefined)
    fail(403, "Application keys are not accepted from browsers", {
      code: "origin_rejected",
    });
  const tokenHash = hashToken(token);
  const principal = await ctx.store.tx((t) => t.principalByTokenHash(tokenHash));
  if (!principal) {
    ctx.config.logger.warn("credential rejected", {
      reason: "unknown_token",
    });
    return failOpaque();
  }
  // Read only after authentication, so an unknown caller sees the opaque 404 either way.
  const subject = singleHeader(request, SUBJECT_HEADER);
  const scopes = singleHeader(request, SCOPES_HEADER);
  if (subject === undefined) {
    if (scopes !== undefined)
      fail(400, `${SCOPES_HEADER} requires ${SUBJECT_HEADER}`, SUBJECT_INVALID);
    return { kind: "application", principalId: principal.id };
  }
  const parsed = parseSubjectHeaders(subject, scopes);
  if (!parsed.ok) return fail(400, parsed.message, SUBJECT_INVALID);
  return {
    kind: "subject",
    principalId: principal.id,
    subject: parsed.subject,
    scopes: parsed.scopes,
  };
}

/**
 * What a subject needs for a route: any one of the scopes, nothing grants it (`never`), or
 * any caller may (`any`, public data such as the JWKS). Each route declares it
 * (`api/http/define.ts`).
 */
export type SubjectAccess = readonly SubjectScope[] | "never" | "any";

/**
 * A subject or a token caller reaches a route only with one of the scopes it declares:
 * `403 scope_required`, decided from the route alone before anything is read.
 */
export function requireScopes(scope: AuthScope, access: SubjectAccess): void {
  if (scope.kind !== "subject" && scope.kind !== "token") return;
  if (access === "any") return;
  if (access === "never")
    fail(403, "This route is not available when acting for a subject", {
      code: "scope_required",
      details: { scopes: [] },
    });
  const held = scope.scopes as ReadonlySet<string>;
  if (!(access as readonly SubjectScope[]).some((name) => held.has(name)))
    fail(403, `Scope ${(access as readonly string[]).join(" or ")} required`, {
      code: "scope_required",
      details: { scopes: access },
    });
}

export function accessOf(scope: AuthScope): SessionAccess | undefined {
  switch (scope.kind) {
    case "application":
      return undefined;
    case "subject":
      return { owner: scope.subject };
    case "token":
      return {
        owner: scope.subject,
        ...(scope.agents === "*" ? {} : { agents: scope.agents }),
      };
    // A request with no credential, on a route that serves public data, owns nothing.
    case "anonymous":
      return fail(404, "Not found");
    // A delivery token reaches its Action's callbacks, never a session or vault.
    case "delivery":
      return fail(404, "Not found");
    default: {
      const unknown: never = scope;
      return fail(404, `Unknown credential ${String((unknown as AuthScope).kind)}`);
    }
  }
}

/** The subject whose sessions the request is limited to, if it acts for one. */
export function ownerOf(scope: AuthScope): string | undefined {
  return accessOf(scope)?.owner;
}

/** The application principal behind the request, acting for a subject or not. */
export function requirePrincipal(scope: AuthScope): string {
  if (scope.kind === "application" || scope.kind === "subject")
    return scope.principalId;
  return fail(403, "Application credential required");
}

/**
 * The caller may act on `action`: only the delivery token minted for it. Whether its generation
 * is still the Action's is checked by each callback.
 */
export function scoped(scope: AuthScope, action: Action): void {
  if (
    scope.kind === "delivery" &&
    scope.actionId === action.actionId &&
    scope.agentId === action.agentId
  )
    return;
  fail(403, "This delivery token is for another Action");
}

/** True when a token caller may reach `agentId` (its issuer's allowlist). Other callers always may. */
export function mayUseAgent(scope: AuthScope, agentId: string): boolean {
  return scope.kind !== "token" || scope.agents === "*" || scope.agents.has(agentId);
}

export function requireApplication(scope: AuthScope): string {
  if (scope.kind === "application") return scope.principalId;
  return fail(403, "Application credential required");
}
