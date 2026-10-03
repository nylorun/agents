/**
 * The Tenant API as a Hono app: one for every open Tenant, which arrives with each request as
 * the `tenant` binding. Every route is declared once (`define.ts`) in `routes/`, `../ag-ui/`
 * and `../a2a/`. A request no route matches exactly is authenticated like any other, then
 * answered `404 Route not found`.
 */
import type { Context } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AuthScope, TenantContext } from "../../tenant/context.js";
import { fail } from "../../tenant/http.js";
import type { NodeBindings } from "../../tenant/types.js";
import { a2aRoutes } from "../a2a/endpoint.js";
import { agUiRoutes } from "../ag-ui/endpoint.js";
import { authenticateCaller, declaredRoute, pathSegments, type RouteAccess } from "./define.js";
import { jsonResponse, rejectionOf } from "./respond.js";
import { accessRoutes } from "./routes/access.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { actionRoutes } from "./routes/actions.js";
import { sandboxRoutes } from "./routes/sandboxes.js";
import { sessionRoutes } from "./routes/sessions.js";
import { tenantRoutes } from "./routes/tenant.js";
import { vaultRoutes } from "./routes/vaults.js";

export type TenantBindings = NodeBindings & { readonly tenant: TenantContext };
export type TenantEnv = {
  Bindings: TenantBindings;
  Variables: {
    /** Who is calling, once authenticated. */
    scope: AuthScope;
  };
};

let app: OpenAPIHono<TenantEnv> | undefined;

/** The Tenant API, built on first use. */
export function tenantApi(): OpenAPIHono<TenantEnv> {
  return (app ??= build());
}

/** Who may call `method` on a Tenant path (its decoded segments), if it is a route. */
export function findTenantRoute(
  method: string,
  segments: readonly string[],
): RouteAccess | undefined {
  tenantApi();
  return declaredRoute(method, segments);
}

/** No route: authenticated first, so an unknown credential stays the opaque 404. */
async function notFound(c: Context<TenantEnv>): Promise<Response> {
  await authenticateCaller(c);
  return fail(404, "Route not found");
}

function build(): OpenAPIHono<TenantEnv> {
  const api = new OpenAPIHono<TenantEnv>();
  // Hono serves HEAD with the GET route; the Tenant API has no HEAD routes.
  api.use(async (c, next) => (c.req.method === "HEAD" ? await notFound(c) : await next()));
  // A malformed path is rejected before anything else reads it.
  api.use(async (c, next) => {
    pathSegments(c.env.incoming);
    await next();
  });
  actionRoutes(api);
  endpointRoutes(api);
  sessionRoutes(api);
  sandboxRoutes(api);
  tenantRoutes(api);
  vaultRoutes(api);
  accessRoutes(api);
  agUiRoutes(api);
  a2aRoutes(api);
  api.notFound(notFound);
  api.onError((error, c) => {
    const { outgoing } = c.env;
    // Once a response has started, the rejection can only end it.
    if (outgoing.headersSent) {
      outgoing.end();
      return RESPONSE_ALREADY_SENT;
    }
    const rejection = rejectionOf(error);
    return jsonResponse(rejection.status, rejection.body, rejection.headers);
  });
  return api;
}
