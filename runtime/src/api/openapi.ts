/**
 * The Runtime's OpenAPI 3.2 documents, generated from the routes as declared for serving:
 *
 * - the Tenant API (`tenantDocument`): every Tenant route, with `/health`, `/ready` and
 *   `/openapi.json`. Served at `GET /openapi.json`, packed as `@nylorun/runtime/openapi.json`
 *   and attached to each release.
 * - the Admin API (`adminDocument`): served at `GET /v1/admin/openapi.json` behind the admin
 *   key, packed as `@nylorun/runtime/admin-openapi.json`.
 *
 * Event streams are `text/event-stream` with an `itemSchema` (OpenAPI 3.2). Nothing here reads
 * the environment: the same Runtime makes the same document.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV32,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { HealthResponseSchema, ReadyResponseSchema } from "@nylorun/core/contracts";
import { createAdminApi } from "../host/admin-api.js";
import { RUNTIME_VERSION } from "../version.js";
import { tenantApi } from "./http/app.js";

type OpenApiDocument = ReturnType<OpenApiGeneratorV32["generateDocument"]>;

const PROTOCOL = {
  min: HOST_PROTOCOL.min,
  max: HOST_PROTOCOL.max,
  features: [...HOST_PROTOCOL.features],
};

const bearer = (description: string, bearerFormat?: string) => ({
  type: "http" as const,
  scheme: "bearer",
  ...(bearerFormat ? { bearerFormat } : {}),
  description,
});

/** `/health`, `/ready` and `/openapi.json`: what every listener answers without a key. */
function hostRoutes(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  const route = (config: RouteConfig) => registry.registerPath(config);
  route({
    method: "get",
    path: "/health",
    tags: ["Host"],
    summary: "Check the Runtime",
    description: "The protocol range and features a client checks first. Refuses an `Origin`.",
    responses: {
      200: {
        description: "The Runtime is up",
        content: { "application/json": { schema: HealthResponseSchema.meta({ id: "Health" }) } },
      },
    },
  });
  route({
    method: "get",
    path: "/ready",
    tags: ["Host"],
    summary: "Check the Runtime is ready",
    description: "The listeners, Tenant discovery, Postgres, Restate and S2.",
    responses: {
      200: {
        description: "Ready",
        content: { "application/json": { schema: ReadyResponseSchema.meta({ id: "Ready" }) } },
      },
      503: { description: "Not ready: `checks` says what is not" },
    },
  });
  route({
    method: "get",
    path: "/openapi.json",
    tags: ["Host"],
    summary: "Get this document",
    responses: { 200: { description: "The Tenant API's OpenAPI document" } },
  });
  return registry;
}

function tenantSchemes(registry: OpenAPIRegistry): void {
  registry.registerComponent(
    "securitySchemes",
    "applicationKey",
    bearer(
      "An application key of the Tenant, or a key derived from the admin key. With `Nylorun-Subject` and `Nylorun-Scopes`, it acts for that person, narrowed to those scopes.",
    ),
  );
  registry.registerComponent(
    "securitySchemes",
    "subjectToken",
    bearer(
      "A subject token (`POST /v1/tokens`): one person and one role of the access policy, for at most 15 minutes.",
      "JWT",
    ),
  );
  registry.registerComponent(
    "securitySchemes",
    "executorKey",
    bearer("An executor's token, scoped to its agent. Deprecated with the executor routes."),
  );
  registry.registerComponent("securitySchemes", "publishableKey", {
    type: "apiKey",
    in: "header",
    name: "Nylorun-Key",
    description:
      "A publishable key, sent by a browser page on one of its origins. Public by design: it names the Tenant and grants the access policy's anonymous scopes.",
  });
}

let tenant: OpenApiDocument | undefined;
let admin: OpenApiDocument | undefined;

/** The Tenant API's document. */
export function tenantDocument(): OpenApiDocument {
  if (tenant) return tenant;
  const host = hostRoutes();
  tenantSchemes(host);
  tenant = new OpenApiGeneratorV32([
    ...host.definitions,
    ...tenantApi().openAPIRegistry.definitions,
  ]).generateDocument({
    openapi: "3.2.0",
    info: {
      title: "Nylorun Runtime: Tenant API",
      version: RUNTIME_VERSION,
      description:
        "Agents, sessions and their events, vaults, access and the Tenant's settings, for one Tenant (`Nylorun-Tenant`). Every request sends `Nylorun-Protocol`. Who may call each operation is its `security` and its `x-nylorun-credentials`, `x-nylorun-scopes` (the subject scopes that reach it) and `x-nylorun-browser` fields.",
      "x-nylorun-protocol": PROTOCOL,
    },
    servers: [
      {
        url: "{origin}",
        description: "A Runtime: the local stack (`nylorun start`), or where yours runs",
        variables: { origin: { default: "http://localhost:8787" } },
      },
    ],
  });
  return tenant;
}

/** The Admin API's document. */
export function adminDocument(): OpenApiDocument {
  if (admin) return admin;
  // Only the routes' declarations are read: nothing is served from this app.
  const api = createAdminApi({
    module: undefined as never,
    status: () => Promise.reject(new Error("Not served")),
    shutdown: () => {},
  });
  api.openAPIRegistry.registerComponent(
    "securitySchemes",
    "adminKey",
    bearer("The Host's admin key (`host-credentials.json`). Never a Tenant bearer."),
  );
  admin = new OpenApiGeneratorV32(api.openAPIRegistry.definitions).generateDocument({
    openapi: "3.2.0",
    info: {
      title: "Nylorun Runtime: Admin API",
      version: RUNTIME_VERSION,
      description:
        "Tenants and the Host's status, with the admin key. Served on the operator listener when the Host has one; the public listener answers these routes with the opaque 404.",
      "x-nylorun-protocol": PROTOCOL,
    },
    servers: [
      {
        url: "{origin}",
        description: "The operator listener: the local stack's, or where yours runs",
        variables: { origin: { default: "http://localhost:8788" } },
      },
    ],
  });
  return admin;
}
