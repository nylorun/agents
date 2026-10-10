/**
 * How the Runtime declares an HTTP route: once, for both serving and the OpenAPI document.
 *
 * `app.openapi(route, handler)` from `@hono/zod-openapi` also validates the path, query and
 * body before the handler runs, answering failures its own way. The Runtime's handlers parse
 * where they always have (after the lookups and checks a rejection must come after), so their
 * rejections keep their order and messages; `serveRoute` registers the route and serves it
 * with no validators of its own.
 */
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { Env, Handler } from "hono";

export function serveRoute<E extends Env>(
  app: OpenAPIHono<E>,
  route: RouteConfig,
  handler: Handler<E>,
): void {
  app.openAPIRegistry.registerPath(route);
  app.on(route.method.toUpperCase(), route.path.replaceAll(/\/{(.+?)}/g, "/:$1"), handler);
}
