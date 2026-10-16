/**
 * The Runtime and Management APIs as one Hono app: one for every open Tenant, which arrives with each request as
 * the `tenant` binding. Every route is declared once (`define.ts`) in `routes/`, `../ag-ui/`
 * and `../a2a/`. A request no route matches exactly is authenticated like any other, then
 * answered `404 Route not found`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { AuthScope, TenantContext } from "../../tenant/context.js";
import type { NodeBindings } from "../../tenant/types.js";
import { a2aRoutes } from "../a2a/endpoint.js";
import { agUiRoutes } from "../ag-ui/endpoint.js";
import { declaredRoute, pathSegments, routeNotFound, type RouteAccess } from "./define.js";
import { jsonResponse, rejectionOf } from "./respond.js";
import { accessRoutes } from "./routes/access.js";
import { meRoutes } from "./routes/me.js";
import { agentRoutes } from "./routes/agents.js";
import { triggerRoutes, webhookRoutes } from "./routes/triggers.js";
import { agentManifestRoutes } from "./routes/agent-manifests.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { readRoutes } from "./routes/reads.js";
import { sessionRoutes } from "./routes/sessions.js";
import { fileRoutes } from "./routes/files.js";
import { keyRoutes } from "./routes/keys.js";
import { tenantRoutes } from "./routes/tenant.js";
import { coverageRoutes } from "./routes/coverage.js";
import { mcpRoutes } from "./routes/mcp.js";

export type TenantBindings = NodeBindings & { readonly tenant: TenantContext };
export type TenantEnv = {
  Bindings: TenantBindings;
  Variables: {
    /** Who is calling, once authenticated. */
    scope: AuthScope;
  };
};

let app: OpenAPIHono<TenantEnv> | undefined;

/** The Runtime and Management APIs' app, built on first use. */
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

function build(): OpenAPIHono<TenantEnv> {
  const api = new OpenAPIHono<TenantEnv>();
  // Hono serves HEAD with the GET route; only the declared HEAD routes answer one.
  api.use(async (c, next) =>
    c.req.method === "HEAD" && !declaredRoute("HEAD", pathSegments(c.env.incoming))
      ? await routeNotFound(c)
      : await next(),
  );
  // A malformed path is rejected before anything else reads it.
  api.use(async (c, next) => {
    pathSegments(c.env.incoming);
    await next();
  });
  sessionRoutes(api);
  fileRoutes(api);
  agentRoutes(api);
  triggerRoutes(api);
  webhookRoutes(api);
  agentManifestRoutes(api);
  artifactRoutes(api);
  tenantRoutes(api);
  keyRoutes(api);
  coverageRoutes(api);
  mcpRoutes(api);
  accessRoutes(api);
  meRoutes(api);
  agUiRoutes(api);
  a2aRoutes(api);
  api.notFound(routeNotFound);
  api.onError((error, c) => {
    const { outgoing, tenant } = c.env;
    const rejection = rejectionOf(error);
    // The client sees only `internal_error`: the operator's log has the cause. The route's
    // pattern, not its path, and never the body, which may hold secrets.
    if (rejection.status === 500)
      tenant.config.logger.error("request_failed", {
        method: c.req.method,
        route: c.req.routePath,
        error: error.message,
        stack: error.stack,
      });
    // Once a response has started, the rejection can only end it.
    if (outgoing.headersSent) {
      outgoing.end();
      return RESPONSE_ALREADY_SENT;
    }
    return jsonResponse(rejection.status, rejection.body, rejection.headers);
  });
  readRoutes(api);
  return api;
}
