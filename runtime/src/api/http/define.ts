/**
 * How a Tenant API route is declared: once, with who may call it, for serving and for the
 * OpenAPI document.
 *
 * `RouteAccess` says which credentials a route takes, which subject scopes reach it (as
 * `routeAccess` in `tenant/auth.ts` decides) and whether browsers may call it. The document
 * shows it as the operation's `security`, its `Nylorun-*` headers and `x-nylorun-*` fields.
 * Serving runs the Tenant's checks in the order the router it replaces ran them: the browser
 * client, the bearer, the subject's scopes, then the handler, which parses its body where it
 * always has.
 */
import type { IncomingMessage } from "node:http";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Handler, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { SubjectScope } from "@nylorun/core/contracts";
import { authenticate, authorize } from "../../tenant/auth.js";
import { identifyClient } from "../../tenant/browser.js";
import { fail } from "../../tenant/http.js";
import { ProtocolRejected, Rejected } from "../components.js";
import type { TenantEnv } from "./app.js";

export type Credential =
  | "application"
  | "subject"
  | "token"
  | "publishable"
  | "executor"
  | "delivery";

export interface RouteAccess {
  readonly credentials: readonly Credential[];
  /** The subject scopes that reach the route: any one of them, none (`never`), or all (`any`). */
  readonly scopes: readonly SubjectScope[] | "never" | "any";
  /** A browser page may call it: its preflight is allowed. */
  readonly browser?: boolean;
}

const SCHEMES: Record<Credential, string> = {
  application: "applicationKey",
  subject: "applicationKey",
  token: "subjectToken",
  publishable: "publishableKey",
  executor: "executorKey",
  delivery: "deliveryToken",
};

const rejected = (description: string) => ({
  description,
  content: { "application/json": { schema: Rejected } },
});

/** The route's path segments, decoded, as the Tenant's checks read them. */
export function pathSegments(incoming: IncomingMessage): string[] {
  return new URL(incoming.url ?? "/", "http://runtime").pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return fail(400, "Malformed path");
      }
    });
}

function authenticated(access: RouteAccess): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const { tenant, incoming, outgoing } = c.env;
    // The client app first: a browser's origin is checked, and CORS headers set, before the
    // bearer is looked at, so every answer from here on is readable by an allowed page.
    const client = await identifyClient(tenant, incoming, outgoing);
    const scope = await authenticate(tenant, incoming, client);
    authorize(scope, incoming.method, pathSegments(incoming));
    if (scope.kind === "publishable" && !access.credentials.includes("publishable"))
      fail(403, "A publishable key alone reaches only the agent list", {
        code: "scope_required",
      });
    // Handlers tell callers apart by kind, and a delivery token is none of theirs: only the
    // routes that list it may see one.
    if (scope.kind === "delivery" && !access.credentials.includes("delivery"))
      fail(403, "A delivery token reaches only its Action's callbacks");
    c.set("scope", scope);
    await next();
  };
}

export function tenantRoute(
  api: OpenAPIHono<TenantEnv>,
  access: RouteAccess,
  route: RouteConfig,
  handler: Handler<TenantEnv>,
): void {
  const takes = (credential: Credential) => access.credentials.includes(credential);
  const schemes = [...new Set(access.credentials.map((credential) => SCHEMES[credential]))];
  const headers = z.object({
    "Nylorun-Protocol": z.string().meta({ description: "The protocol version, `2`" }),
    ...(access.browser || takes("publishable")
      ? {
          "Nylorun-Tenant": z
            .string()
            .optional()
            .meta({ description: "The Tenant; optional with a publishable key, which names it" }),
        }
      : { "Nylorun-Tenant": z.string().meta({ description: "The Tenant" }) }),
    ...(takes("subject")
      ? {
          "Nylorun-Subject": z
            .string()
            .optional()
            .meta({ description: "The person an application key acts for" }),
          "Nylorun-Scopes": z
            .string()
            .optional()
            .meta({ description: "The subject's space-separated scopes; required with a subject" }),
        }
      : {}),
    ...(takes("publishable")
      ? {
          "Nylorun-Key": z
            .string()
            .optional()
            .meta({ description: "A publishable key, from a browser page on an allowed origin" }),
        }
      : {}),
  });
  api.openAPIRegistry.registerPath({
    ...route,
    security: schemes.map((scheme) => ({ [scheme]: [] })),
    request: { ...route.request, headers },
    responses: {
      400: rejected("Invalid headers, path, body or cursor"),
      ...(takes("token") ? { 401: rejected("The subject token expired or was revoked (`token_expired`)") } : {}),
      403: rejected("Not allowed for this credential, subject scope or origin"),
      404: rejected("Not found, or a credential the Tenant does not know (`not_found`)"),
      426: { description: "`Nylorun-Protocol` missing or unsupported", content: { "application/json": { schema: ProtocolRejected } } },
      ...(takes("token") ? { 429: rejected("The subject's turn limits are reached (`limit_exceeded`)") } : {}),
      503: rejected("The Tenant's storage or streams are unavailable"),
      ...route.responses,
    },
    "x-nylorun-credentials": access.credentials,
    "x-nylorun-scopes": access.scopes,
    "x-nylorun-browser": access.browser === true,
  } as RouteConfig);
  api.on(
    route.method.toUpperCase(),
    route.path.replaceAll(/\/{(.+?)}/g, "/:$1"),
    authenticated(access),
    handler,
  );
}
