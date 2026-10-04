/**
 * How a Tenant API route is declared: once, with who may call it, for serving and for the
 * OpenAPI document.
 *
 * `RouteAccess` says which credentials a route takes, which subject scopes reach it and
 * whether browsers may call it: the one statement of who may call a route. The document shows
 * it as the operation's `security`, its `Nylorun-*` headers and `x-nylorun-*` fields; the Host
 * answers browser preflights from it (`findTenantRoute`). Serving runs the Tenant's checks in
 * order: the browser client, the bearer, the subject's scopes, then the handler, which parses
 * its body.
 */
import type { IncomingMessage } from "node:http";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { SubjectScope } from "@nylorun/core/contracts";
import { authenticate, requireScopes } from "../../tenant/auth.js";
import { identifyClient } from "../../tenant/browser.js";
import type { AuthScope } from "../../tenant/context.js";
import { fail } from "../../tenant/http.js";
import { ProtocolRejected, Rejected } from "../components.js";
import type { TenantEnv } from "./app.js";

export type Credential =
  | "application"
  | "subject"
  | "token"
  | "publishable"
  | "delivery";

export interface RouteAccess {
  readonly credentials: readonly Credential[];
  /** The subject scopes that reach the route: any one of them, none (`never`), or all (`any`). */
  readonly scopes: readonly SubjectScope[] | "never" | "any";
  /** A browser page may call it: its preflight is allowed. */
  readonly browser?: boolean;
  /**
   * Public data: a request with no credential at all (no `Authorization`, no `Nylorun-Key`) is
   * served too. A credential that is sent is still checked, so a wrong one stays the opaque 404.
   */
  readonly anonymous?: boolean;
  /**
   * The body is the bytes of a file, of any media type (an artifact upload): the Host lets it
   * through without `application/json`, and the handler streams it.
   */
  readonly bytes?: boolean;
  /**
   * Served without `Nylorun-Protocol` (a capability link, opened by a browser or an `<img>`):
   * the Host checks the header only when it is sent.
   */
  readonly unversioned?: boolean;
}

const SCHEMES: Record<Credential, string> = {
  application: "applicationKey",
  subject: "applicationKey",
  token: "subjectToken",
  publishable: "publishableKey",
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

/** Who is calling: the browser client and the bearer, as every Tenant request checks them. */
export async function authenticateCaller(
  c: Context<TenantEnv>,
  /** The route serves public data (`RouteAccess.anonymous`): no credential is needed. */
  anonymous = false,
): Promise<AuthScope> {
  const { tenant, incoming, outgoing } = c.env;
  // The client app first: a browser's origin is checked, and CORS headers set, before the
  // bearer is looked at, so every answer from here on is readable by an allowed page.
  const client = await identifyClient(tenant, incoming, outgoing);
  if (anonymous && !client && incoming.headers.authorization === undefined)
    return { kind: "anonymous" };
  return await authenticate(tenant, incoming, client);
}

/** A declared route: what `findTenantRoute` looks up. */
interface Declared {
  readonly method: string;
  readonly segments: readonly string[];
  readonly access: RouteAccess;
}
const declared: Declared[] = [];

/** The declared route `method path` is, if any. `{param}` segments match any one segment. */
export function declaredRoute(
  method: string,
  segments: readonly string[],
): RouteAccess | undefined {
  return declared.find(
    (route) =>
      route.method === method.toUpperCase() &&
      route.segments.length === segments.length &&
      route.segments.every(
        (segment, index) =>
          segment === segments[index] ||
          (segment.startsWith("{") && segments[index] !== ""),
      ),
  )?.access;
}

function authenticated(access: RouteAccess): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const scope = await authenticateCaller(c, access.anonymous === true);
    requireScopes(scope, access.scopes);
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
  const protocol = z.string().meta({ description: `The protocol version, \`${PROTOCOL_VERSION}\`` });
  const headers = z.object({
    "Nylorun-Protocol": access.unversioned ? protocol.optional() : protocol,
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
    // `{}`: no credential needed (OpenAPI's optional security).
    security: [
      ...schemes.map((scheme) => ({ [scheme]: [] })),
      ...(access.anonymous ? [{}] : []),
    ],
    request: { ...route.request, headers },
    responses: {
      400: rejected("Invalid headers, path, body or cursor"),
      ...(takes("token")
        ? {
            401: rejected(
              "The token expired or was revoked (`token_expired`), or its issuer's keys cannot be fetched now (`issuer_unavailable`)",
            ),
          }
        : {}),
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
  declared.push({
    method: route.method.toUpperCase(),
    segments: route.path.split("/").filter(Boolean),
    access,
  });
  api.on(
    route.method.toUpperCase(),
    route.path.replaceAll(/\/{(.+?)}/g, "/:$1"),
    authenticated(access),
    handler,
  );
}
