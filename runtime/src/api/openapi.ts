/**
 * The Runtime's two OpenAPI 3.2 documents, generated from the routes as declared for serving
 * (protocol 8): the Runtime API (`runtimeDocument`: `/openapi/runtime.json`, alias
 * `/openapi.json`, `@nylorun/runtime/openapi.json`) and the Management API (`managementDocument`:
 * `/openapi/management.json`, `@nylorun/runtime/management-openapi.json`). Both are attached to
 * each release. Each has described tags in the order a developer uses them; the Runtime API
 * groups them (`x-tagGroups`).
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

/**
 * `/health`, `/ready` and the documents: what every listener answers without a key. The
 * `/openapi.json` alias is served but left out of the documents.
 */
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
    path: "/openapi/runtime.json",
    tags: ["Host"],
    summary: "Get the Runtime API's document",
    description: "This document. `/openapi.json` is the same.",
    responses: { 200: { description: "The Runtime API's OpenAPI document" } },
  });
  route({
    method: "get",
    path: "/openapi/management.json",
    tags: ["Host"],
    summary: "Get the Management API's document",
    responses: { 200: { description: "The Management API's OpenAPI document" } },
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
}

/**
 * One tag of a reference document: its group (the Runtime API's sidebar headings), what it is
 * for, and its operations in the order a developer uses them. Every operation of the Runtime
 * belongs to exactly one tag of one document (`documents()` throws otherwise); `/v1/me` is in
 * both.
 */
interface Tag {
  name: string;
  group?: string;
  description: string;
  operations: readonly string[];
}

const RUNTIME_TAGS: readonly Tag[] = [
  {
    name: "Agents",
    group: "Agents",
    description: "The agents a Tenant can run: put a definition, list what is there. In `@nylorun/agents`.",
    operations: ["PUT /v1/agents/{agentId}", "GET /v1/agents"],
  },
  {
    name: "Definition files",
    group: "Agents",
    description:
      "The files a definition names by the SHA-256 of their bytes (each skill's folder): upload each once before putting the definition, which is refused while it names one the Runtime does not hold (`definition_files_missing`). `saveAgent` in `@nylorun/agents` does both.",
    operations: ["PUT /v1/files/{file}", "HEAD /v1/files/{file}"],
  },
  {
    name: "Sessions API",
    group: "Sessions",
    description:
      "A conversation with an agent: open a session, send commands, follow its events, read its history. In `@nylorun/agents`.",
    operations: [
      "PUT /v1/sessions/{sessionId}",
      "GET /v1/sessions",
      "GET /v1/sessions/{sessionId}",
      "POST /v1/sessions/{sessionId}/commands",
      "GET /v1/sessions/{sessionId}/events",
      "GET /v1/sessions/{sessionId}/items",
      "GET /v1/sessions/{sessionId}/manifest",
      "GET /v1/sessions/{sessionId}/usage",
      "GET /v1/sessions/{sessionId}/calls/model",
      "POST /v1/sessions/{sessionId}/sandbox/{tool}",
    ],
  },
  {
    name: "AG-UI",
    group: "Sessions",
    description:
      "The same sessions through AG-UI: a thread is one session per person, agent and thread, and each run is a turn.",
    operations: [
      "POST /v1/ag-ui/agents/{agentId}",
      "GET /v1/ag-ui/agents/{agentId}/threads/{threadId}/events",
      "GET /v1/ag-ui/agents/{agentId}/threads/{threadId}/messages",
      "POST /v1/ag-ui/agents/{agentId}/threads/{threadId}/cancel",
    ],
  },
  {
    name: "A2A",
    group: "Sessions",
    description:
      "The same sessions through Agent2Agent: a context is one session per subject, agent and `contextId`, and a task is one turn. The card is how an A2A client finds the agent.",
    operations: ["GET /v1/a2a/agents/{agentId}/card", "POST /v1/a2a/agents/{agentId}"],
  },
  {
    name: "Sandboxes",
    group: "Sandboxes",
    description:
      "Isolated machines an agent works in: create or find one, watch its lifecycle, stop, reset or delete it. In `@nylorun/agents`.",
    operations: [
      "PUT /v1/sandboxes/{sandboxId}",
      "GET /v1/sandboxes",
      "GET /v1/sandboxes/{sandboxId}",
      "GET /v1/sandboxes/{sandboxId}/events",
      "POST /v1/sandboxes/{sandboxId}/stop",
      "POST /v1/sandboxes/{sandboxId}/reset",
      "DELETE /v1/sandboxes/{sandboxId}",
    ],
  },
  {
    name: "Artifacts",
    group: "Artifacts",
    description:
      "Files and folders agents and people produce, versioned, with short-lived capability links to share them. In `@nylorun/agents`.",
    operations: [
      "POST /v1/artifacts",
      "GET /v1/artifacts",
      "GET /v1/artifacts/{artifactId}",
      "POST /v1/artifacts/{artifactId}/versions",
      "GET /v1/artifacts/{artifactId}/versions/{version}/content",
      "GET /v1/artifacts/{artifactId}/versions/{version}/tree",
      "GET /v1/artifacts/{artifactId}/versions/{version}/files/{path}",
      "GET /v1/artifacts/{artifactId}/versions/{version}/diff",
      "GET /v1/artifacts/{artifactId}/versions/{version}/zip",
      "POST /v1/artifacts/{artifactId}/links",
      "GET /v1/artifact-links/{token}",
      "DELETE /v1/artifacts/{artifactId}",
    ],
  },
  {
    name: "Service",
    group: "Service",
    description:
      "Check a Runtime is up and speaks your protocol, ask who your credential is, and read the public keys of the tokens it signs. `/health`, `/ready`, the JWKS and the documents need no key.",
    operations: [
      "GET /health",
      "GET /ready",
      "GET /v1/me",
      "GET /v1/access/jwks",
      "GET /openapi/runtime.json",
    ],
  },
];

const MANAGEMENT_TAGS: readonly Tag[] = [
  {
    name: "Tenant",
    description:
      "The Tenant's status, and seeding or resetting it. `admin.tenant` in `@nylorun/admin`.",
    operations: [
      "GET /v1/tenant",
      "PUT /v1/tenant/config/seed",
      "POST /v1/tenant/reset",
      "GET /v1/me",
      "GET /openapi/management.json",
    ],
  },
  {
    name: "Application keys",
    description:
      "The keys app servers call the Runtime API with: create, rotate, list and delete them. Management keys come only from the Tenant's machine. `admin.keys`.",
    operations: ["GET /v1/tenant/keys", "PUT /v1/tenant/keys/{keyId}", "DELETE /v1/tenant/keys/{keyId}"],
  },
  {
    name: "Models",
    description:
      "Model providers, their credentials, the model the Tenant uses, what it spent, every model call for export, and the budgets that cap it. `admin.models`.",
    operations: [
      "GET /v1/tenant/models",
      "GET /v1/tenant/providers",
      "GET /v1/tenant/model",
      "PUT /v1/tenant/model",
      "PUT /v1/tenant/model/selection",
      "GET /v1/tenant/usage",
      "GET /v1/tenant/calls/model",
      "GET /v1/tenant/budgets",
      "PUT /v1/tenant/budgets",
    ],
  },
  {
    name: "Vaults",
    description:
      "The installation's credentials for agents' tools: API keys and MCP OAuth connections. Sessions attach a vault by id. `admin.vaults`.",
    operations: [
      "POST /v1/tenant/vaults",
      "GET /v1/tenant/vaults",
      "GET /v1/tenant/vaults/{vaultId}",
      "DELETE /v1/tenant/vaults/{vaultId}",
      "POST /v1/tenant/vaults/{vaultId}/credentials",
      "GET /v1/tenant/vaults/{vaultId}/credentials",
      "GET /v1/tenant/vaults/{vaultId}/credentials/{credentialId}",
      "POST /v1/tenant/vaults/{vaultId}/credentials/{credentialId}",
      "DELETE /v1/tenant/vaults/{vaultId}/credentials/{credentialId}",
      "POST /v1/tenant/vaults/{vaultId}/oauth/start",
      "GET /v1/oauth/callback",
    ],
  },
  {
    name: "Signing keys",
    description:
      "The keys the Runtime signs capability links and run tokens with; their public halves are the Runtime API's JWKS. `admin.signingKeys`.",
    operations: [
      "GET /v1/tenant/signing-keys",
      "POST /v1/tenant/signing-keys/rotate",
      "POST /v1/tenant/signing-keys/{kid}/revoke",
    ],
  },
  {
    name: "Settings",
    description: "The Tenant's sandbox and artifact settings. `admin.settings`.",
    operations: [
      "GET /v1/tenant/sandbox",
      "PUT /v1/tenant/sandbox",
      "GET /v1/tenant/artifacts",
      "PUT /v1/tenant/artifacts",
    ],
  },
];

const METHODS = ["get", "head", "put", "post", "delete", "patch"] as const;
const SERVERS = [
  {
    url: "{origin}",
    description: "A Runtime: a local Tenant (`nylorun start`), or where yours runs",
    variables: { origin: { default: "http://localhost:8787" } },
  },
];

/** The `#/components/schemas/…` names `value` refers to, followed through `schemas`. */
function referencedSchemas(value: unknown, schemas: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length);
        if (!found.has(name)) {
          found.add(name);
          walk(schemas[name]);
        }
      } else walk(child);
    }
  };
  walk(value);
  return found;
}

/** One reference document: `tags`' operations of `all`, in their order, with what they use. */
function document(
  all: OpenApiDocument,
  tags: readonly Tag[],
  info: { title: string; description: string },
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const tag of tags)
    for (const name of tag.operations) {
      const [method, path] = name.split(" ") as [string, string];
      const operation = (all.paths?.[path] as Record<string, unknown> | undefined)?.[method.toLowerCase()];
      if (!operation) throw new Error(`The Runtime has no operation ${name}`);
      (paths[path] ??= {})[method.toLowerCase()] = { ...(operation as object), tags: [tag.name] };
    }
  const schemas = (all.components?.schemas ?? {}) as Record<string, unknown>;
  const used = referencedSchemas(paths, schemas);
  const schemes = new Set<string>();
  for (const item of Object.values(paths))
    for (const operation of Object.values(item))
      for (const requirement of ((operation as { security?: Record<string, unknown>[] }).security ?? []))
        for (const scheme of Object.keys(requirement)) schemes.add(scheme);
  const groups = [...new Set(tags.flatMap((tag) => (tag.group ? [tag.group] : [])))];
  return {
    ...all,
    info: { ...all.info, ...info },
    tags: tags.map((tag) => ({ name: tag.name, description: tag.description })),
    ...(groups.length
      ? {
          "x-tagGroups": groups.map((group) => ({
            name: group,
            tags: tags.filter((tag) => tag.group === group).map((tag) => tag.name),
          })),
        }
      : {}),
    paths,
    components: {
      ...all.components,
      schemas: Object.fromEntries(Object.entries(schemas).filter(([name]) => used.has(name))),
      securitySchemes: Object.fromEntries(
        Object.entries(all.components?.securitySchemes ?? {}).filter(([name]) => schemes.has(name)),
      ),
    },
  } as OpenApiDocument;
}

let built: { runtime: OpenApiDocument; management: OpenApiDocument } | undefined;

/** Both reference documents, built once from every route; throws when one is left out. */
function documents(): { runtime: OpenApiDocument; management: OpenApiDocument } {
  if (built) return built;
  const host = hostRoutes();
  tenantSchemes(host);
  const all = new OpenApiGeneratorV32([
    ...host.definitions,
    ...tenantApi().openAPIRegistry.definitions,
  ]).generateDocument({
    openapi: "3.2.0",
    info: { title: "Nylorun Runtime", version: RUNTIME_VERSION, "x-nylorun-protocol": PROTOCOL },
    servers: SERVERS,
  });
  const listed = new Set([...RUNTIME_TAGS, ...MANAGEMENT_TAGS].flatMap((tag) => tag.operations));
  for (const [path, item] of Object.entries(all.paths ?? {}))
    for (const method of METHODS)
      if ((item as Record<string, unknown>)[method] && !listed.has(`${method.toUpperCase()} ${path}`))
        throw new Error(`${method.toUpperCase()} ${path} is in no reference tag (api/openapi.ts)`);
  built = {
    runtime: document(all, RUNTIME_TAGS, {
      title: "Nylorun Runtime API",
      description:
        "For developers: agents, sessions (with AG-UI and A2A), sandboxes and artifacts, through `@nylorun/agents`. Every Tenant serves it on its one URL, beside the Management API (`/openapi/management.json`). Every request sends `Nylorun-Protocol`. Who may call each operation is its `security` and its `x-nylorun-credentials` and `x-nylorun-scopes` (the subject scopes that reach it) fields: an application key (servers) or a trusted issuer's token (browsers and apps).",
    }),
    management: document(all, MANAGEMENT_TAGS, {
      title: "Nylorun Management API",
      description:
        "For operators: the Tenant's models, vaults, signing keys, settings and application keys, at `/v1/tenant/*` on the Tenant's URL, through `@nylorun/admin`. Every operation takes a management key, acting as itself: never for a subject and never from a browser. Management keys are issued only on the Tenant's machine (`nylorun key put <id> --management`) or from `NYLORUN_MANAGEMENT_KEY_FILE`.",
    }),
  };
  return built;
}

/** The Runtime API's document: `/openapi/runtime.json` and `/openapi.json`. */
export function runtimeDocument(): OpenApiDocument {
  return documents().runtime;
}

/** The Management API's document: `/openapi/management.json`. */
export function managementDocument(): OpenApiDocument {
  return documents().management;
}
