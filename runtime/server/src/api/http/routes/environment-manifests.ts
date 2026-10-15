/**
 * Environment manifests (`/v1/environment-manifests/**`, protocol 14, D63): save, read, list and
 * delete the named, versioned definitions Environments are made from. A save never changes an
 * Environment. Reading needs what reading an Environment needs; saving and deleting need
 * `environments:write`, from any client (Q12).
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { isEnvironmentManifestName, PutEnvironmentManifestRequestSchema } from "@nylorun/core/contracts";
import {
  DeleteEnvironmentManifestResponse,
  EnvironmentManifestPlan,
  EnvironmentManifestVersions,
  EnvironmentManifestView,
  ListEnvironmentManifestsResponse,
  PutEnvironmentManifestRequest,
  SaveEnvironmentManifestResponse,
} from "../../components.js";
import { fail } from "../../../tenant/http.js";
import {
  deleteEnvironmentManifest,
  environmentManifestVersions,
  getEnvironmentManifest,
  listEnvironmentManifests,
  saveEnvironmentManifest,
} from "../../../tenant/environment-manifests.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const READ: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own", "environments:write"],
};
const WRITE: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["environments:write"],
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const namePath = z.object({
  name: z.string().meta({ description: "The environment manifest's name, such as `analyst-box`" }),
});

function nameOf(value: string | undefined): string {
  if (!isEnvironmentManifestName(value))
    return fail(400, "An environment manifest's name is 1-64 letters, digits, '.', '_' and '-', starting with a letter or digit");
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

export function environmentManifestRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environment-manifests",
      tags: ["Environment manifests"],
      summary: "List environment manifests",
      description: "Each manifest's latest version, by name, with how many Environments were made from it.",
      responses: { 200: json(ListEnvironmentManifestsResponse, "The manifests") },
    },
    async (c) => jsonResponse(200, await listEnvironmentManifests(c.env.tenant)),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/environment-manifests/{name}",
      tags: ["Environment manifests"],
      summary: "Save an environment manifest",
      description:
        "Saves the manifest as its next version, or answers the latest unchanged when nothing differs. No Environment changes: an Environment keeps the version it was made from, and a fork moves it to another (D63). `If-Match: <version>` refuses the save with `412 manifest_changed` when the latest version is no longer the one you read (`0` for a manifest that does not exist yet). With `?dryRun=true` the answer is the plan: the changes, every reason a save would be refused (`errors`), warnings, and how many Environments stay on older versions; nothing is saved. Clients drop a file's `$schema` before they send it.",
      request: {
        params: namePath,
        query: z.object({
          dryRun: z.enum(["true", "false"]).optional().meta({ description: "`true`: answer the plan and save nothing" }),
        }),
        body: { required: true, content: { "application/json": { schema: PutEnvironmentManifestRequest } } },
      },
      responses: {
        200: json(z.union([SaveEnvironmentManifestResponse, EnvironmentManifestPlan]), "The version saved, or the plan with dryRun"),
        400: { description: "The manifest breaks the Tenant's limits or names files the Runtime cannot use" },
        412: { description: "If-Match named a version that is no longer the latest (`manifest_changed`)" },
      },
    },
    async (c) => {
      const name = nameOf(c.req.param("name"));
      const body = PutEnvironmentManifestRequestSchema.parse(await readJson(c));
      const ifMatch = ifMatchOf(c.req.header("if-match"));
      const options = ifMatch === undefined ? {} : { ifMatch };
      return jsonResponse(
        200,
        c.req.query("dryRun") === "true"
          ? await saveEnvironmentManifest(c.env.tenant, name, body, c.get("scope"), { ...options, dryRun: true })
          : await saveEnvironmentManifest(c.env.tenant, name, body, c.get("scope"), options),
      );
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environment-manifests/{name}",
      tags: ["Environment manifests"],
      summary: "Get an environment manifest",
      description: "Its latest version.",
      request: { params: namePath },
      responses: { 200: json(EnvironmentManifestView, "The latest version") },
    },
    async (c) => jsonResponse(200, await getEnvironmentManifest(c.env.tenant, nameOf(c.req.param("name")))),
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environment-manifests/{name}/versions",
      tags: ["Environment manifests"],
      summary: "List an environment manifest's versions",
      description: "Every version, newest first, with who saved it and how many Environments were made from it.",
      request: { params: namePath },
      responses: { 200: json(EnvironmentManifestVersions, "The versions") },
    },
    async (c) => jsonResponse(200, await environmentManifestVersions(c.env.tenant, nameOf(c.req.param("name")))),
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environment-manifests/{name}/versions/{version}",
      tags: ["Environment manifests"],
      summary: "Get one version of an environment manifest",
      request: { params: namePath.extend({ version: z.string().meta({ description: "The version number" }) }) },
      responses: { 200: json(EnvironmentManifestView, "The version") },
    },
    async (c) =>
      jsonResponse(
        200,
        await getEnvironmentManifest(c.env.tenant, nameOf(c.req.param("name")), versionOf(c.req.param("version"))),
      ),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/environment-manifests/{name}",
      tags: ["Environment manifests"],
      summary: "Delete an environment manifest",
      description: "Deletes every version. Refused while any Environment was made from one (`409 manifest_in_use`).",
      request: { params: namePath },
      responses: {
        200: json(DeleteEnvironmentManifestResponse, "Deleted, or there was none"),
        409: { description: "An Environment was made from one of its versions (`manifest_in_use`)" },
      },
    },
    async (c) => jsonResponse(200, await deleteEnvironmentManifest(c.env.tenant, nameOf(c.req.param("name")))),
  );
}
