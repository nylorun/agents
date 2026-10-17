/**
 * Agent manifests (`/v1/agent-manifests/**`, protocol 16): save, read, list and delete the named,
 * versioned documents Agents are made from, each with a harness and a runtime section. A save
 * moves every Agent that tracks the manifest to the new version; a pinned one stays. Reading needs `agents:read` (or a write scope), saving and deleting
 * `agent-manifests:write`, from any client (Q12). A token caller reaches none: a manifest holds
 * an agent's instructions, tools and servers.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { isAgentManifestName, PutAgentManifestRequestSchema } from "@nylorun/core/contracts";
import {
  AgentManifestPlan,
  AgentManifestVersions,
  AgentManifestView,
  DeleteAgentManifestResponse,
  ListAgentManifestsResponse,
  PutAgentManifestRequest,
  SaveAgentManifestResponse,
} from "../../components.js";
import { requirePrincipal } from "../../../tenant/auth.js";
import { fail } from "../../../tenant/http.js";
import {
  agentManifestVersions,
  deleteAgentManifest,
  getAgentManifest,
  listAgentManifests,
  saveAgentManifest,
} from "../../../tenant/agent-manifests.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const READ: RouteAccess = {
  credentials: ["application", "subject"],
  scopes: ["agents:read", "agents:write", "agent-manifests:write"],
};
const WRITE: RouteAccess = {
  credentials: ["application", "subject"],
  scopes: ["agent-manifests:write"],
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const namePath = z.object({
  name: z.string().meta({ description: "The agent manifest's name, such as `triage`" }),
});

function nameOf(value: string | undefined): string {
  if (!isAgentManifestName(value))
    return fail(400, "An agent manifest's name is 1-64 letters, digits, '.', '_' and '-', starting with a letter or digit");
  return value;
}

function versionOf(value: string | undefined): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) return fail(400, "version is a positive integer");
  return version;
}

/** `If-Match: <version>` (or `"<version>"`), when sent. */
function ifMatchOf(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const version = Number(value.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!Number.isInteger(version) || version < 0) return fail(400, "If-Match is the version you read: a whole number, 0 for none yet");
  return version;
}

export function agentManifestRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agent-manifests",
      tags: ["Agent manifests"],
      summary: "List agent manifests",
      description: "Each manifest's latest version, by name, with how many Agents were made from it.",
      responses: { 200: json(ListAgentManifestsResponse, "The manifests") },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      return jsonResponse(200, await listAgentManifests(c.env.tenant));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/agent-manifests/{name}",
      tags: ["Agent manifests"],
      summary: "Save an agent manifest",
      description:
        "Saves the manifest as its next version, or answers the latest unchanged when nothing differs. Every Agent that tracks the manifest moves to the new version: at once, at its pod's next start for a runtime change a pod applies only when it starts, or once a required secret the version adds is set; a pinned one stays, and so does one whose kind, harness or storage the version changes (`agents_behind`). The Runtime checks the harness and runtime sections against each other: a custom harness needs a pod with an image, every credential the harness names is a declared slot of the right type, and the runtime's kind gives the loop the sandbox it needs; every gap is named in one `422 manifest_inconsistent` (`details.gaps`). `If-Match: <version>` refuses the save with `412 manifest_changed` when the latest version is no longer the one you read (`0` for a manifest that does not exist yet). With `?dryRun=true` the answer is the plan: the changes by section, every reason a save would be refused (`errors`, the gaps first), warnings, the Agents it would move (`moves`) and how many stay on older versions (`behind`); nothing is saved. Clients compose the authoring files and drop their `$schema` before they send one document.",
      request: {
        params: namePath,
        query: z.object({
          dryRun: z.enum(["true", "false"]).optional().meta({ description: "`true`: answer the plan and save nothing" }),
        }),
        body: { required: true, content: { "application/json": { schema: PutAgentManifestRequest } } },
      },
      responses: {
        200: json(z.union([SaveAgentManifestResponse, AgentManifestPlan]), "The version saved, or the plan with dryRun"),
        400: {
          description:
            "The manifest breaks the Tenant's limits, has a tool that runs code, or names files the Runtime does not hold (`definition_files_missing`)",
        },
        412: { description: "If-Match named a version that is no longer the latest (`manifest_changed`)" },
        413: { description: "A skill's files hold more than the manifest's skill limit together (`limit_exceeded`)" },
        422: { description: "The harness and runtime sections do not fit (`manifest_inconsistent`, `details.gaps`)" },
      },
    },
    async (c) => {
      const name = nameOf(c.req.param("name"));
      const body = PutAgentManifestRequestSchema.parse(await readJson(c));
      const ifMatch = ifMatchOf(c.req.header("if-match"));
      const options = ifMatch === undefined ? {} : { ifMatch };
      return jsonResponse(
        200,
        c.req.query("dryRun") === "true"
          ? await saveAgentManifest(c.env.tenant, name, body, c.get("scope"), { ...options, dryRun: true })
          : await saveAgentManifest(c.env.tenant, name, body, c.get("scope"), options),
      );
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agent-manifests/{name}",
      tags: ["Agent manifests"],
      summary: "Get an agent manifest",
      description: "Its latest version.",
      request: { params: namePath },
      responses: { 200: json(AgentManifestView, "The latest version") },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      return jsonResponse(200, await getAgentManifest(c.env.tenant, nameOf(c.req.param("name"))));
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agent-manifests/{name}/versions",
      tags: ["Agent manifests"],
      summary: "List an agent manifest's versions",
      description: "Every version, newest first, with who saved it and how many Agents were made from it.",
      request: { params: namePath },
      responses: { 200: json(AgentManifestVersions, "The versions") },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      return jsonResponse(200, await agentManifestVersions(c.env.tenant, nameOf(c.req.param("name"))));
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agent-manifests/{name}/versions/{version}",
      tags: ["Agent manifests"],
      summary: "Get one version of an agent manifest",
      request: { params: namePath.extend({ version: z.string().meta({ description: "The version number" }) }) },
      responses: { 200: json(AgentManifestView, "The version") },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      return jsonResponse(200, await getAgentManifest(c.env.tenant, nameOf(c.req.param("name")), versionOf(c.req.param("version"))));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/agent-manifests/{name}",
      tags: ["Agent manifests"],
      summary: "Delete an agent manifest",
      description: "Deletes every version. Refused while any Agent was made from one (`409 manifest_in_use`).",
      request: { params: namePath },
      responses: {
        200: json(DeleteAgentManifestResponse, "Deleted, or there was none"),
        409: { description: "An Agent was made from one of its versions (`manifest_in_use`)" },
      },
    },
    async (c) => jsonResponse(200, await deleteAgentManifest(c.env.tenant, nameOf(c.req.param("name")))),
  );
}
