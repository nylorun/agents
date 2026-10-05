/**
 * The Runtime's OpenAPI 3.2 document (`tenantDocument`), generated from the routes as declared
 * for serving: every Tenant route, with `/health`, `/ready` and `/openapi.json`. Served at
 * `GET /openapi.json`, packed as `@nylorun/runtime/openapi.json` and attached to each release.
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
    description:
      "The listener, the Tenant (open), Postgres, Restate and S2, and the open Tenant's harnesses.",
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
      "An application key of the Tenant (`PUT /v1/tenant/keys/{keyId}`), or Studio's key, derived from the admin key. With `Nylorun-Subject` and `Nylorun-Scopes`, it acts for that person, narrowed to those scopes. Never accepted from a browser (`Origin`).",
    ),
  );
  registry.registerComponent(
    "securitySchemes",
    "managementKey",
    bearer(
      "A management key of the Tenant (role `management`): it reaches the Management API (`/v1/tenant/*`) and `/v1/me`, as itself, never for a subject. Issued only on the Tenant's machine (`nylorun-operate keys put <id> --role management`) or from `NYLORUN_MANAGEMENT_KEY_FILE`. Never accepted from a browser (`Origin`).",
    ),
  );
  registry.registerComponent(
    "securitySchemes",
    "issuerToken",
    bearer(
      "A JWT from a trusted issuer of the Host's identity file (Host feature `trusted-issuers`): one person, with the issuer's scopes, agents and sandbox grants, until it expires. Accepted from servers and browsers alike; CORS is the operator's proxy's.",
      "JWT",
    ),
  );
  registry.registerComponent(
    "securitySchemes",
    "deliveryToken",
    bearer(
      "The delivery token the Runtime signs each Action delivery with (`Nylorun-Signature`), sent back by the Action endpoint. It reaches only that Action's heartbeat, result and sandbox routes, while that delivery is current, for at most 15 minutes.",
      "JWT",
    ),
  );
}

let tenant: OpenApiDocument | undefined;

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
        "Agents, sessions and their events, vaults, access and the Tenant's settings. A Runtime serves one Tenant: its URL is the Tenant's, and no request names it. Every request sends `Nylorun-Protocol`. Who may call each operation is its `security` and its `x-nylorun-credentials` and `x-nylorun-scopes` (the subject scopes that reach it) fields.",
      "x-nylorun-protocol": PROTOCOL,
    },
    servers: [
      {
        url: "{origin}",
        description: "A Runtime: a local Tenant (`nylorun start`), or where yours runs",
        variables: { origin: { default: "http://localhost:8787" } },
      },
    ],
  });
  return tenant;
}
