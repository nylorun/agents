/**
 * Tenant request authentication and authorization: a bearer token resolves to an application
 * principal or a registered executor; anything else is the opaque 404 (D5). An application
 * principal may act for a subject (`Nylorun-Subject`, `Nylorun-Scopes`); `authorize` then
 * limits the request to the routes its scopes allow, decided from the route alone.
 */
import type { IncomingMessage } from "node:http";
import {
  SCOPES_HEADER,
  SUBJECT_HEADER,
} from "@nylorun/core/compatibility";
import {
  parseSubjectHeaders,
  type Action,
  type SubjectScope,
} from "@nylorun/core/contracts";
import { hashToken } from "../core/executors.js";
import type { AuthScope, TenantContext } from "./context.js";
import { fail, failOpaque } from "./http.js";

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
  const tokenHash = hashToken(token);
  const principal = await ctx.store.tx((t) => t.principalByTokenHash(tokenHash));
  const executor = principal ? undefined : ctx.registry.find(tokenHash);
  if (!principal && !executor) {
    ctx.config.logger.warn("credential rejected", {
      reason: "unknown_token",
    });
    return failOpaque();
  }
  // Read only after authentication, so an unknown caller sees the opaque 404 either way.
  const subject = singleHeader(request, SUBJECT_HEADER);
  const scopes = singleHeader(request, SCOPES_HEADER);
  if (executor) {
    if (subject !== undefined || scopes !== undefined)
      fail(403, "An executor credential cannot act for a subject");
    return { kind: "executor", executor };
  }
  if (subject === undefined) {
    if (scopes !== undefined)
      fail(400, `${SCOPES_HEADER} requires ${SUBJECT_HEADER}`, SUBJECT_INVALID);
    return { kind: "application", principalId: principal!.id };
  }
  const parsed = parseSubjectHeaders(subject, scopes);
  if (!parsed.ok) return fail(400, parsed.message, SUBJECT_INVALID);
  return {
    kind: "subject",
    principalId: principal!.id,
    subject: parsed.subject,
    scopes: parsed.scopes,
  };
}

/** What a subject needs for a route: any one of the scopes, or nothing grants it. */
export type RouteAccess = readonly SubjectScope[] | "never";

const SESSIONS: RouteAccess = ["sessions:own"];
const VAULTS: RouteAccess = ["vaults:own"];
const SETTINGS: RouteAccess = ["tenant:settings"];

/**
 * The scopes a subject needs for `method path` (`path` starts with `v1`). `undefined` for a
 * route that does not exist. Operator and executor routes are `never`: reset, config seed,
 * executors, actions and the sandbox tool routes.
 */
export function routeAccess(
  method: string | undefined,
  path: readonly string[]
): RouteAccess | undefined {
  const [v1, resource, id, sub] = path;
  const n = path.length;
  if (v1 !== "v1" || !resource) return undefined;
  switch (resource) {
    case "executors":
    case "actions":
      return "never";
    case "agents":
      if (n === 2 && method === "GET") return ["agents:read", "agents:write"];
      if (n === 3 && method === "PUT") return ["agents:write"];
      return undefined;
    case "sessions":
      if (n === 2 && method === "GET") return SESSIONS;
      if (n === 3 && (method === "GET" || method === "PUT")) return SESSIONS;
      if (n === 4 && method === "GET" && (sub === "items" || sub === "events"))
        return SESSIONS;
      if (n === 4 && method === "POST" && sub === "commands") return SESSIONS;
      if (n === 5 && method === "POST" && sub === "sandbox") return "never";
      return undefined;
    case "vaults":
      if (n === 2) return method === "GET" || method === "POST" ? VAULTS : undefined;
      if (n === 3) return method === "GET" || method === "DELETE" ? VAULTS : undefined;
      if (sub !== "credentials") return undefined;
      if (n === 4) return method === "GET" || method === "POST" ? VAULTS : undefined;
      if (n === 5)
        return method === "GET" || method === "POST" || method === "DELETE"
          ? VAULTS
          : undefined;
      return undefined;
    case "tenant":
      if (n === 2 && method === "GET") return SETTINGS;
      if (n === 3 && id === "reset" && method === "POST") return "never";
      if (n === 4 && id === "config" && sub === "seed" && method === "PUT")
        return "never";
      if (n === 3 && method === "GET" && (id === "models" || id === "providers"))
        return ["tenant:settings", "agents:write"];
      if (n === 3 && method === "GET" && id === "sandbox") return SETTINGS;
      if (n === 3 && id === "model" && (method === "GET" || method === "PUT"))
        return SETTINGS;
      if (n === 4 && id === "model" && sub === "selection" && method === "PUT")
        return SETTINGS;
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Limits a subject to the routes its scopes allow. Decided from the route alone, before any
 * lookup, so a refusal reveals nothing about which resources exist. A route the table does not
 * know is a 404 for a subject: new routes stay closed until they are added here. Application
 * and executor scopes pass through to the checks each route makes today.
 */
export function authorize(
  scope: AuthScope,
  method: string | undefined,
  path: readonly string[]
): void {
  if (scope.kind !== "subject") return;
  const access = routeAccess(method, path);
  if (access === undefined) fail(404, "Route not found");
  if (access === "never")
    fail(403, "This route is not available when acting for a subject", {
      code: "scope_required",
      details: { scopes: [] },
    });
  if (!(access as readonly SubjectScope[]).some((name) => scope.scopes.has(name)))
    fail(403, `Scope ${(access as readonly string[]).join(" or ")} required`, {
      code: "scope_required",
      details: { scopes: access },
    });
}

/** The subject whose sessions and vaults the request is limited to, if it acts for one. */
export function ownerOf(scope: AuthScope): string | undefined {
  return scope.kind === "subject" ? scope.subject : undefined;
}

/** The application principal behind the request, acting for a subject or not. */
export function requirePrincipal(scope: AuthScope): string {
  if (scope.kind !== "executor") return scope.principalId;
  return fail(403, "Application credential required");
}

/** The executor scope must belong to the Action's agent. */
export function scoped(scope: AuthScope, action: Action): void {
  if (scope.kind !== "executor" || scope.executor.agentId !== action.agentId)
    fail(403, "Executor scope does not authorize this action");
}

export function requireApplication(scope: AuthScope): string {
  if (scope.kind === "application") return scope.principalId;
  return fail(403, "Application credential required");
}
