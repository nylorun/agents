/**
 * The Tenant API as a Hono app: one for every open Tenant, which arrives with each request as
 * the `tenant` binding. Routes move here group by group; until a route has, the Tenant's
 * router (`routes.ts`) answers it on the Node response.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { TenantContext } from "../../tenant/context.js";
import type { NodeBindings } from "../../tenant/types.js";
import { handle } from "./routes.js";

export type TenantBindings = NodeBindings & { readonly tenant: TenantContext };
export type TenantEnv = { Bindings: TenantBindings };

let app: OpenAPIHono<TenantEnv> | undefined;

/** The Tenant API, built on first use. */
export function tenantApi(): OpenAPIHono<TenantEnv> {
  return (app ??= build());
}

function build(): OpenAPIHono<TenantEnv> {
  const api = new OpenAPIHono<TenantEnv>();
  api.notFound(async (c) => {
    const { tenant, incoming, outgoing } = c.env;
    await handle(tenant, incoming, outgoing, new URL(incoming.url ?? "/", "http://runtime"));
    return RESPONSE_ALREADY_SENT;
  });
  // The Host answers what a Tenant throws (`host/app.ts`), as it did before Hono.
  api.onError((error) => {
    throw error;
  });
  return api;
}
