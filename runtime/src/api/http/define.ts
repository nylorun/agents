/**
 * How a Tenant API route is declared: once, with who may call it, for serving and for the
 * OpenAPI document.
 *
 * `RouteAccess` says which credentials a route takes and which subject scopes reach it: the one
 * statement of who may call a route. The document shows it as the operation's `security`, its
 * `Nylorun-*` headers and `x-nylorun-*` fields. Serving runs the Tenant's checks in order: the
 * bearer, the subject's scopes, then the handler, which parses its body. The Runtime sends no
 * CORS headers: a browser reaches it through the operator's proxy, with a trusted issuer's
 * token.
 */
import type { IncomingMessage } from "node:http";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { SubjectScope } from "@nylorun/core/contracts";
import { authenticate, requireScopes, type KeyAccess } from "../../tenant/auth.js";
import type { AuthScope } from "../../tenant/context.js";
import { fail } from "../../tenant/http.js";
import { ProtocolRejected, Rejected } from "../components.js";
import type { TenantEnv } from "./app.js";

/**
 * A route's credentials. `application` and `subject` are an application key, alone or acting
 * for a person; `management` a management key (the Management API, protocol 8); `token` a
 * trusted issuer's JWT; `delivery` an Action's delivery token.
 */
export type Credential = "application" | "subject" | "management" | "token" | "delivery";

export interface RouteAccess {
  readonly credentials: readonly Credential[];
  /** The subject scopes that reach the route: any one of them, none (`never`), or all (`any`). */
  readonly scopes: readonly SubjectScope[] | "never" | "any";
  /**
   * Public data: a request with no credential at all (no `Authorization`) is served too. A credential that is sent is still checked, so a wrong one stays the opaque 404.
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
  management: "managementKey",
  token: "issuerToken",
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

/** Who is calling: the bearer, as every Tenant request checks it. */
export async function authenticateCaller(
  c: Context<TenantEnv>,
  /** The route serves public data (`RouteAccess.anonymous`): no credential is needed. */
  anonymous = false,
  /** The keys the route takes; a Runtime API route's by default. */
  keys?: KeyAccess,
): Promise<AuthScope> {
  const { tenant, incoming } = c.env;
  if (anonymous && incoming.headers.authorization === undefined) return { kind: "anonymous" };
  return await authenticate(tenant, incoming, keys);
}

/** Which keys a route's credentials take. */
export function keyAccess(access: RouteAccess): KeyAccess {
  const takes = (credential: Credential) => access.credentials.includes(credential);
  // Only a Management API route turns an application key away for its role; elsewhere the
  // route's own checks answer as they always have (a delivery token's callbacks, say).
  return {
    application: takes("application") || takes("subject") || !takes("management"),
    management: takes("management"),
  };
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
    const scope = await authenticateCaller(c, access.anonymous === true, keyAccess(access));
    requireScopes(scope, access.scopes);
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
              "The token expired (`token_expired`), or its issuer's keys cannot be fetched now (`issuer_unavailable`)",
            ),
          }
        : {}),
      403: rejected(
        takes("management")
          ? "Not allowed for this credential, a key of the other API (`key_role_mismatch`), a key from a browser (`origin_rejected`) or a management key acting for a subject"
          : "Not allowed for this credential or subject scope, a key of the other API (`key_role_mismatch`), or an application key from a browser (`origin_rejected`)",
      ),
      404: rejected("Not found, or a credential the Tenant does not know (`not_found`)"),
      426: { description: "`Nylorun-Protocol` missing or unsupported", content: { "application/json": { schema: ProtocolRejected } } },
      503: rejected("The Tenant's storage or streams are unavailable"),
      ...route.responses,
    },
    "x-nylorun-credentials": access.credentials,
    "x-nylorun-scopes": access.scopes,
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
