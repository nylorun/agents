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
import { z } from "zod";
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

/** RFC 9728 protected resource metadata, as `tenant/resource-server.ts` builds it. */
const ProtectedResourceMetadataSchema = z
  .object({
    resource: z.string().meta({ description: "The Runtime API: `NYLORUN_PUBLIC_URL`, else the origin the request reached" }),
    authorization_servers: z
      .array(z.string())
      .meta({ description: "The identity file's issuers, in its order: a client usually signs in at the first" }),
    scopes_supported: z.array(z.string()).meta({ description: "The scopes the issuers' tokens may carry, `studio` aside" }),
    bearer_methods_supported: z.array(z.literal("header")),
    resource_name: z.string(),
  })
  .meta({ id: "ProtectedResourceMetadata" });

/**
 * `/health`, `/ready`, the documents and the OAuth metadata: what every listener answers
 * without a key. The `/openapi.json` alias is served but left out of the documents.
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
    path: "/.well-known/oauth-protected-resource",
    tags: ["Host"],
    summary: "Get the protected resource metadata",
    description:
      "OAuth 2.0 Protected Resource Metadata (RFC 9728): the identity providers whose access tokens the Runtime API accepts (the identity file's trusted issuers) and their scopes. Nylorun is never the authorization server: a client signs in at one of `authorization_servers` and presents its token as `Authorization: Bearer`. A `401` from the Runtime API names this document in `WWW-Authenticate` (`resource_metadata`). Needs no key or `Nylorun-Protocol`, and accepts an `Origin`.",
    responses: {
      200: {
        description: "The metadata",
        content: { "application/json": { schema: ProtectedResourceMetadataSchema } },
      },
      404: { description: "The Runtime trusts no identity provider (no identity file)" },
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
    name: "Agent manifests",
    group: "Agents",
    description:
      "Named, versioned agent manifests (protocol 16): one document with what runs inside an agent's loop (`harness`) and what the Runtime provides around it (`runtime`), checked against each other when it is saved. Save one with a plan first (`?dryRun=true`) and `If-Match`; an Agent runs one version at a time, and a save moves every Agent that tracks the manifest to the new version, while a pinned one stays. `client.agentManifests` in `@nylorun/agents`, and `nylorun apply`.",
    operations: [
      "PUT /v1/agent-manifests/{name}",
      "GET /v1/agent-manifests",
      "GET /v1/agent-manifests/{name}",
      "GET /v1/agent-manifests/{name}/versions",
      "GET /v1/agent-manifests/{name}/versions/{version}",
      "GET /v1/agent-manifests/{name}/versions/{version}/source",
      "GET /v1/agent-manifests/{name}/versions/{version}/source/files/{path}",
      "GET /v1/agent-manifests/{name}/source/diff",
      "DELETE /v1/agent-manifests/{name}",
    ],
  },
  {
    name: "Definition files",
    group: "Agents",
    description:
      "The files an agent manifest names by the SHA-256 of their bytes (each skill's folder, a runtime section's input files): upload each once before saving the manifest, which is refused while it names one the Runtime does not hold (`definition_files_missing`) or a skill whose files hold more than its skill limit together (`limit_exceeded`; `/v1/tenant/skills`, default 2 GiB). No file and no count of files has a limit of its own. `client.agentManifests.save` in `@nylorun/agents` does both.",
    operations: ["PUT /v1/files/{file}", "HEAD /v1/files/{file}"],
  },
  {
    name: "Agents",
    group: "Agents",
    description:
      "The live instances of agent manifests: an Agent has a stable id, its manifest version, one sandbox (a virtual workspace, a pod with its own volume, or none), one vault of secrets for its shell, MCP servers and HTTP tools, its disk versions, and its sessions. Its `state` says whether it is working, sleeping, needs a person (`input_required`), is failing or paused. Create or find one from a saved manifest, watch its lifecycle, stop, reset, fork or delete it, and write its secrets. In `@nylorun/agents`.",
    operations: [
      "PUT /v1/agents/{agentId}",
      "GET /v1/agents",
      "GET /v1/agents/{agentId}",
      "GET /v1/agents/{agentId}/events",
      "POST /v1/agents/{agentId}/stop",
      "POST /v1/agents/{agentId}/reset",
      "POST /v1/agents/{agentId}/restart",
      "DELETE /v1/agents/{agentId}",
      "GET /v1/agents/{agentId}/secrets",
      "GET /v1/agents/{agentId}/secrets/{name}",
      "PUT /v1/agents/{agentId}/secrets/{name}",
      "DELETE /v1/agents/{agentId}/secrets/{name}",
      "POST /v1/agents/{agentId}/snapshot",
      "POST /v1/agents/{agentId}/restore",
      "POST /v1/agents/{agentId}/fork",
      "GET /v1/agents/{agentId}/versions",
      "DELETE /v1/agents/{agentId}/versions/{version}",
    ],
  },
  {
    name: "Triggers",
    group: "Agents",
    description:
      "What starts an Agent's turns with no client connected: the schedules, one-shot times and webhook endpoints its manifest's `runtime.triggers` declare. Each trigger's status is the Agent's: pause and resume it, run it now, make a webhook trigger's signing secret, and read its runs (`started`, `queued`, `skipped` or `failed`, with a reason). In `@nylorun/agents` and `nylorun agents triggers`.",
    operations: [
      "GET /v1/agents/{agentId}/triggers",
      "POST /v1/agents/{agentId}/triggers/{triggerId}/pause",
      "POST /v1/agents/{agentId}/triggers/{triggerId}/resume",
      "POST /v1/agents/{agentId}/triggers/{triggerId}/run",
      "GET /v1/agents/{agentId}/runs",
      "POST /v1/agents/{agentId}/triggers/{triggerId}/secret",
      "POST /v1/webhooks/{endpointId}",
    ],
  },
  {
    name: "Memory",
    group: "Agents",
    description:
      "An Agent's memories: Markdown files under `/memories` it keeps across sessions, wakes and upgrades, shaped like Anthropic's memory stores. List and read them, write one whole (with a `content_sha256` precondition), delete one or a folder, and read the version every change leaves, with who made it. In `@nylorun/agents` and `nylorun agents memories`.",
    operations: [
      "GET /v1/agents/{agentId}/memories",
      "GET /v1/agents/{agentId}/memories/{path}",
      "PUT /v1/agents/{agentId}/memories/{path}",
      "DELETE /v1/agents/{agentId}/memories/{path}",
      "GET /v1/agents/{agentId}/memory_versions",
      "GET /v1/agents/{agentId}/memory_versions/{versionId}",
    ],
  },
  {
    name: "Sessions API",
    group: "Sessions",
    description:
      "A conversation with an Agent: open a session on it, send commands, follow its events, read its history. No session is special: an app that keeps one conversation going reuses its id. In `@nylorun/agents`.",
    operations: [
      "PUT /v1/sessions/{sessionId}",
      "GET /v1/sessions",
      "GET /v1/sessions/{sessionId}",
      "POST /v1/sessions/{sessionId}/commands",
      "GET /v1/sessions/{sessionId}/events",
      "GET /v1/sessions/{sessionId}/items",
      "GET /v1/sessions/{sessionId}/manifest",
      "GET /v1/sessions/{sessionId}/model",
      "PUT /v1/sessions/{sessionId}/model",
      "DELETE /v1/sessions/{sessionId}/model",
      "GET /v1/sessions/{sessionId}/usage",
      "GET /v1/sessions/{sessionId}/calls/model",
      "GET /v1/sessions/{sessionId}/calls/tool",
      "GET /v1/sessions/{sessionId}/turns/{turnId}/trace",
      "POST /v1/sessions/{sessionId}/sandbox/{tool}",
      "GET /v1/turns",
    ],
  },
  {
    name: "AG-UI",
    group: "Sessions",
    description:
      "The same sessions through AG-UI: a thread is one session per person, Agent and thread, and each run is a turn.",
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
      "The same sessions through Agent2Agent: a context is one session per subject, Agent and `contextId`, and a task is one turn; every caller's session runs on the Agent's disk and vault, so an app that serves several audiences makes an Agent for each. The card is how an A2A client finds the Agent.",
    operations: ["GET /v1/a2a/agents/{agentId}/card", "POST /v1/a2a/agents/{agentId}"],
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
      "Check a Runtime is up and speaks your protocol, ask who your credential is, find the identity providers it takes tokens from, and read the public keys of the tokens it signs. `/health`, `/ready`, the protected resource metadata, the JWKS and the documents need no key.",
    operations: [
      "GET /health",
      "GET /ready",
      "GET /v1/me",
      "GET /.well-known/oauth-protected-resource",
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
      "Model providers, their credentials, the model the Tenant uses, what each model reads, what it spent, every model call for export, and the budgets that cap it. `admin.models`.",
    operations: [
      "GET /v1/tenant/models",
      "PUT /v1/tenant/models/inputs",
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
    name: "Tool policy",
    description:
      "The rules the Tool Gate applies to every MCP and HTTP tool call of every harness: refuse it, hold it for a person's approval, or run it. `admin.toolPolicy`.",
    operations: ["GET /v1/tenant/tool-policy", "PUT /v1/tenant/tool-policy"],
  },
  {
    name: "Credential coverage",
    description:
      "Which secret of an Agent's vault each of its manifest's MCP servers and HTTP tools would get, before a session opens. The secrets themselves are written on the Runtime API. `admin.coverage`.",
    operations: ["POST /v1/tenant/credential-coverage"],
  },
  {
    name: "MCP servers",
    description:
      "See a remote MCP server's tools before an agent names it, with an Agent's credential for its URL: their model names, sizes and annotations, or that it needs a person's sign-in. `admin.mcp`.",
    operations: ["POST /v1/tenant/mcp/preview"],
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
    description:
      "The Tenant's sandbox backend, Agent compute, artifact and skill settings, and its Runtime limits. `admin.settings`.",
    operations: [
      "GET /v1/tenant/sandbox",
      "PUT /v1/tenant/sandbox",
      "GET /v1/tenant/artifacts",
      "PUT /v1/tenant/artifacts",
      "GET /v1/tenant/skills",
      "PUT /v1/tenant/skills",
      "GET /v1/tenant/limits",
      "PUT /v1/tenant/limits",
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
        "For developers: agent manifests, Agents, sessions (with AG-UI and A2A) and artifacts, through `@nylorun/agents`. Every Tenant serves it on its one URL, beside the Management API (`/openapi/management.json`). Every request sends `Nylorun-Protocol`. Who may call each operation is its `security` and its `x-nylorun-credentials` and `x-nylorun-scopes` (the subject scopes that reach it) fields: an application key (servers) or a trusted issuer's token (browsers and apps).",
    }),
    management: document(all, MANAGEMENT_TAGS, {
      title: "Nylorun Management API",
      description:
        "For operators: the Tenant's models, vaults, signing keys, settings and application keys, at `/v1/tenant/*` on the Tenant's URL, through `@nylorun/admin`. Every operation takes a management key, acting as itself: never for a subject and never from a browser. Management keys are issued only on the Tenant's machine (`nylorun tenant keys put <id> --management`) or from `NYLORUN_MANAGEMENT_KEY_FILE`.",
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
