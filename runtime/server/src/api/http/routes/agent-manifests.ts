/**
 * Agent manifests (`/v1/agent-manifests/**`, protocol 16): save, read, list and delete the named,
 * versioned documents Agents are made from, each with a harness and a runtime section. A save
 * moves every Agent that tracks the manifest to the new version; a pinned one stays. Reading needs `agents:read` (or a write scope), saving and deleting
 * `agent-manifests:write`, from any client (Q12). A token caller reaches none: a manifest holds
 * an agent's instructions, tools and servers. A save may send an agent folder by hash instead of
 * the manifest (track T6): the Runtime compiles it and keeps it as the version's source, and
 * `source/diff` compares two versions' sources (track T7).
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  AGENT_FOLDER_MEDIA_TYPE,
  contentTypeFor,
  isAgentManifestName,
  PutAgentFolderRequestSchema,
  PutAgentManifestRequestSchema,
} from "@nylorun/core/contracts";
import {
  AgentManifestPlan,
  AgentManifestSource,
  AgentManifestSourceDiff,
  AgentManifestVersions,
  AgentManifestView,
  DeleteAgentManifestResponse,
  ListAgentManifestsResponse,
  PutAgentFolderRequest,
  PutAgentManifestRequest,
  SaveAgentManifestResponse,
} from "../../components.js";
import { requirePrincipal } from "../../../tenant/auth.js";
import { fail } from "../../../tenant/http.js";
import {
  agentManifestVersions,
  deleteAgentManifest,
  diffAgentManifestSources,
  getAgentManifest,
  getAgentManifestSource,
  listAgentManifests,
  readAgentManifestSourceFile,
  saveAgentFolder,
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
        "Saves the manifest as its next version, or answers the latest unchanged when nothing differs. Every Agent that tracks the manifest moves to the new version: at once, at its pod's next start for a runtime change a pod applies only when it starts, or once a required secret the version adds is set; a pinned one stays, and so does one whose kind, harness or storage the version changes (`agents_behind`). The Runtime checks the harness and runtime sections against each other: a custom harness needs a pod with an image, every credential the harness names is a declared slot of the right type, and the runtime's kind gives the loop the sandbox it needs; every gap is named in one `422 manifest_inconsistent` (`details.gaps`). `If-Match: <version>` refuses the save with `412 manifest_changed` when the latest version is no longer the one you read (`0` for a manifest that does not exist yet). With `?dryRun=true` the answer is the plan: the changes by section, every reason a save would be refused (`errors`, the gaps first), warnings, the Agents it would move (`moves`) and how many stay on older versions (`behind`); nothing is saved. Clients compose the authoring files and drop their `$schema` before they send one document. With `Content-Type: application/vnd.nylorun.folder+json` the body is an agent folder by hash instead (feature `agent-folders`): every file uploaded first with `PUT /v1/files/sha256:<hex>`, the Runtime compiles it with `@nylorun/core/folder`, a folder that does not compile is `422 folder_invalid` (`details.diagnostics`, each with its file, line and column), and the version keeps the folder as its source; the plan adds the compiled `manifest`, the compiler's `diagnostics` and `compiler`.",
      request: {
        params: namePath,
        query: z.object({
          dryRun: z.enum(["true", "false"]).optional().meta({ description: "`true`: answer the plan and save nothing" }),
        }),
        body: {
          required: true,
          content: {
            "application/json": { schema: PutAgentManifestRequest },
            [AGENT_FOLDER_MEDIA_TYPE]: { schema: PutAgentFolderRequest },
          },
        },
      },
      responses: {
        200: json(z.union([SaveAgentManifestResponse, AgentManifestPlan]), "The version saved, or the plan with dryRun"),
        400: {
          description:
            "The manifest breaks the Tenant's limits, has a tool that runs code, or names files the Runtime does not hold (`definition_files_missing`)",
        },
        412: { description: "If-Match named a version that is no longer the latest (`manifest_changed`)" },
        413: { description: "A skill's files hold more than the manifest's skill limit together (`limit_exceeded`)" },
        422: {
          description:
            "The harness and runtime sections do not fit (`manifest_inconsistent`, `details.gaps`), or an agent folder does not compile (`folder_invalid`, `details.diagnostics`)",
        },
      },
    },
    async (c) => {
      const name = nameOf(c.req.param("name"));
      const ifMatch = ifMatchOf(c.req.header("if-match"));
      const options = { ...(ifMatch === undefined ? {} : { ifMatch }), ...(c.req.query("dryRun") === "true" ? { dryRun: true } : {}) };
      const media = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (media === AGENT_FOLDER_MEDIA_TYPE) {
        const folder = PutAgentFolderRequestSchema.parse(await readJson(c));
        return jsonResponse(200, await saveAgentFolder(c.env.tenant, name, folder, c.get("scope"), options));
      }
      const body = PutAgentManifestRequestSchema.parse(await readJson(c));
      return jsonResponse(
        200,
        options.dryRun
          ? await saveAgentManifest(c.env.tenant, name, body, c.get("scope"), { ...options, dryRun: true })
          : await saveAgentManifest(c.env.tenant, name, body, c.get("scope"), { ...options, dryRun: false }),
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
    READ,
    {
      method: "get",
      path: "/v1/agent-manifests/{name}/versions/{version}/source",
      tags: ["Agent manifests"],
      summary: "Get the folder a version was compiled from",
      description:
        "The agent folder the version was saved from (feature `agent-folders`): its compiler, size and every file, sorted by path. A version saved as JSON has none (`404`).",
      request: { params: namePath.extend({ version: z.string().meta({ description: "The version number" }) }) },
      responses: { 200: json(AgentManifestSource, "The folder") },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      return jsonResponse(
        200,
        await getAgentManifestSource(c.env.tenant, nameOf(c.req.param("name")), versionOf(c.req.param("version"))),
      );
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agent-manifests/{name}/versions/{version}/source/files/{path}",
      tags: ["Agent manifests"],
      summary: "Download one file of a version's folder",
      description: "Streams the file at `path` (its path in the folder, with `/` percent-encoded as `%2F`) as it was saved.",
      request: {
        params: namePath.extend({
          version: z.string().meta({ description: "The version number" }),
          path: z.string().meta({ description: "The file's path in the folder, percent-encoded" }),
        }),
      },
      responses: {
        200: {
          description: "The file's bytes",
          content: { "application/octet-stream": { schema: z.string().meta({ format: "binary" }) } },
        },
      },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      const path = c.req.param("path")!;
      const file = await readAgentManifestSourceFile(
        c.env.tenant,
        nameOf(c.req.param("name")),
        versionOf(c.req.param("version")),
        path,
      );
      return new Response(file.body, {
        status: 200,
        headers: { "content-type": contentTypeFor(path), "content-length": String(file.size) },
      });
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agent-manifests/{name}/source/diff",
      tags: ["Agent manifests"],
      summary: "Compare two versions' folders",
      description:
        "The files added, removed and changed from version `from`'s source to version `to`'s, by path, a file changed when its SHA-256 differs (feature `agent-folders`). Each list is sorted by path. A version saved as JSON has no source (`404`).",
      request: {
        params: namePath,
        query: z.object({
          from: z.string().meta({ description: "The version to compare from" }),
          to: z.string().meta({ description: "The version to compare to" }),
        }),
      },
      responses: {
        200: json(AgentManifestSourceDiff, "What changed"),
        400: { description: "`from` or `to` is not a version number" },
        404: { description: "No such version, or one was saved as JSON and has no source" },
      },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      const name = nameOf(c.req.param("name"));
      const from = Number(c.req.query("from"));
      const to = Number(c.req.query("to"));
      if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1)
        fail(400, "from and to are the versions to compare: positive integers");
      return jsonResponse(200, await diffAgentManifestSources(c.env.tenant, name, from, to));
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
