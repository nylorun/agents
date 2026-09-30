/**
 * Every Tenant route on Hono declares who may call it (`RouteAccess`, `api/http/define.ts`).
 * Until the router's own tables are retired, the declaration must say what they decide: the
 * subject scopes `routeAccess` requires, and the browser preflights `isBrowserRoute` allows.
 */
import type { RouteConfig } from "@hono/zod-openapi";
import { expect, it } from "vitest";
import { tenantApi } from "../../src/api/http/app.js";
import { isBrowserRoute } from "../../src/host/cors.js";
import { routeAccess } from "../../src/tenant/auth.js";

type Declared = RouteConfig & {
  "x-nylorun-scopes": unknown;
  "x-nylorun-browser": boolean;
};

const routes = tenantApi()
  .openAPIRegistry.definitions.filter((definition) => definition.type === "route")
  .map((definition) => (definition as { route: Declared }).route);

/** A request path for `path`, its parameters filled in. */
function sample(path: string): string[] {
  return path
    .replaceAll("{tool}", "bash")
    .replaceAll(/{[^}]+}/g, "x")
    .split("/")
    .filter(Boolean);
}

it("declares routes", () => {
  expect(routes.length).toBeGreaterThan(0);
});

it.each(routes.map((route) => [`${route.method.toUpperCase()} ${route.path}`, route] as const))(
  "%s declares the scopes and browser access the router's tables decide",
  (_name, route) => {
    const method = route.method.toUpperCase();
    expect(route["x-nylorun-scopes"]).toEqual(routeAccess(method, sample(route.path)));
    expect(route["x-nylorun-browser"]).toBe(isBrowserRoute(method, sample(route.path)));
  },
);
