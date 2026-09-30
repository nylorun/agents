/**
 * The Tenant API as a Hono app: one for every open Tenant, which arrives with each request as
 * the `tenant` binding. Routes move here group by group (`routes/`); a request no route here
 * matches exactly, `HEAD` included, goes to the router they replace (`routes.ts`), which
 * answers on the Node response as before.
 */
import type { Context } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { TenantContext } from "../../tenant/context.js";
import type { AuthScope } from "../../tenant/context.js";
import type { NodeBindings } from "../../tenant/types.js";
import { pathSegments } from "./define.js";
import { jsonResponse, rejectionOf } from "./respond.js";
import { handle } from "./routes.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { executorRoutes } from "./routes/executors.js";
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

async function legacy(c: Context<TenantEnv>): Promise<Response> {
  const { tenant, incoming, outgoing } = c.env;
  await handle(tenant, incoming, outgoing, new URL(incoming.url ?? "/", "http://runtime"));
  return RESPONSE_ALREADY_SENT;
}

function build(): OpenAPIHono<TenantEnv> {
  const api = new OpenAPIHono<TenantEnv>();
  // Hono serves HEAD with the GET route; the Tenant API has no HEAD routes.
  api.use(async (c, next) => (c.req.method === "HEAD" ? await legacy(c) : await next()));
  // A malformed path is rejected before anything else reads it.
  api.use(async (c, next) => {
    pathSegments(c.env.incoming);
    await next();
  });
  executorRoutes(api);
  endpointRoutes(api);
  sessionRoutes(api);
  tenantRoutes(api);
  vaultRoutes(api);
  api.notFound(legacy);
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
