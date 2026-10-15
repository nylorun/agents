/**
 * Environments (`/v1/environments/**`, protocol 11, D55, D56): create, find or change one by id,
 * read it, list them by label, read its lifecycle stream, stop, reset and delete it, and write
 * its vault's secrets. Ids may hold `/`, sent percent-encoded as one path segment
 * (`users%2Falice%2Fweb`). A token caller reaches only the ids its Environment grants match,
 * and changes them only with `environments:write`. Secret values are write-only: no route reads
 * one back.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  ENVIRONMENT_EVENT_TYPES,
  ForkEnvironmentRequestSchema,
  isEnvironmentId,
  PutEnvironmentRequestSchema,
  RestoreEnvironmentRequestSchema,
} from "@nylorun/core/contracts";
import {
  deleteEnvironmentVersion,
  environmentVersions,
  restoreEnvironment,
  snapshotEnvironment,
} from "../../../artifacts/disk.js";
import {
  DeleteEnvironmentResponse,
  DeletedResponse,
  EnvironmentPage,
  EnvironmentRestore,
  EnvironmentSnapshot,
  EnvironmentVersions,
  ForkEnvironmentRequest,
  ForkEnvironmentResponse,
  RestoreEnvironmentRequest,
  EnvironmentSecretView,
  EnvironmentView,
  ListEnvironmentEventsResponse,
  ListEnvironmentSecretsResponse,
  ListEnvironmentsResponse,
  PutEnvironmentRequest,
  PutEnvironmentSecretRequest,
  PutEnvironmentSecretValueRequest,
} from "../../components.js";
import { fail } from "../../../tenant/http.js";
import {
  actorOf,
  assertReaches,
  deleteEnvironment,
  environmentEventsOf,
  forkEnvironment,
  getEnvironment,
  listEnvironments,
  putEnvironment,
  resetEnvironment,
  secretRequestFor,
  stopEnvironment,
} from "../../../tenant/environments.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { environmentPage, pageQuery } from "./reads.js";
import { jsonResponse } from "../respond.js";

/** Reading an Environment: any caller that may use sessions, or change Environments. */
const READ: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own", "environments:write"],
};
/** Creating, changing or deleting one, and writing its secrets. */
const WRITE: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["environments:write"],
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const environmentId = z.object({
  environmentId: z
    .string()
    .meta({ description: "The Environment id, percent-encoded: `users%2Falice%2Fweb` for `users/alice/web`" }),
});
const secretPath = environmentId.extend({
  name: z.string().meta({
    description: "The secret's name: the variable for `environment_secret` and `environment_variable`, a label for `bearer` and `headers`",
  }),
});

/** The path's Environment id, or a 400 naming the rule. */
function idOf(value: string | undefined): string {
  if (!isEnvironmentId(value))
    return fail(
      400,
      "An Environment id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'",
    );
  return value;
}

/** `label=k=v`, repeated: every one must match. */
function labelsOf(values: readonly string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    if (at <= 0) fail(400, `label must be key=value, not ${value}`);
    labels[value.slice(0, at)] = value.slice(at + 1);
  }
  return labels;
}

export function environmentRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environments",
      tags: ["Environments"],
      summary: "List Environments",
      description:
        "Every Environment with all the labels asked for. A token caller sees only the Environments its grants reach.",
      request: {
        query: pageQuery.extend({
          label: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .meta({ description: "`key=value`; repeat it to require several labels" }),
        }),
      },
      responses: {
        200: json(z.union([ListEnvironmentsResponse, EnvironmentPage]), "The Environments; limit opts into pagination"),
      },
    },
    async (c) =>
      jsonResponse(
        200,
        c.req.query("limit") !== undefined
          ? await environmentPage(c.env.tenant, c.get("scope"), c.req.query(), labelsOf(c.req.queries("label")))
          : await listEnvironments(c.env.tenant, labelsOf(c.req.queries("label")), c.get("scope")),
      ),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/environments/{environmentId}",
      tags: ["Environments"],
      summary: "Create, find or change an Environment",
      description:
        "Creates the Environment and its vault within the Tenant's limits, or answers the one with this id, so get-or-create is one call. It is made from one version of an environment manifest (`manifest: \"name\"` takes the latest, `\"name@n\"` version n) or from the inline fields, and never changes what it runs after that (protocol 14, D63): on an existing one, labels replace, `ownerUserId` sets or (with `null`) clears the owner guard, fields that match what it runs are accepted, and anything else is `409 environment_immutable`, which names the fork that makes a new Environment instead. Kind `pod` needs sandbox pods (`nylorun local sandbox enable`) and is created at once.",
      request: {
        params: environmentId,
        body: { required: true, content: { "application/json": { schema: PutEnvironmentRequest } } },
      },
      responses: {
        200: json(EnvironmentView, "The Environment"),
        409: {
          description:
            "An Environment with this id runs something else (`environment_immutable`), the Tenant holds as many Environments as it allows (`limit_exceeded`), kind pod without sandbox pods (`environment_unavailable`), or it is being deleted (`environment_busy`)",
        },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("environmentId"));
      const body = PutEnvironmentRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(200, await putEnvironment(c.env.tenant, id, body, c.get("scope")));
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environments/{environmentId}",
      tags: ["Environments"],
      summary: "Get an Environment",
      description:
        "Its recipe, versions, labels, owner guard, state and the sessions that name it (acting for a person, only theirs).",
      request: { params: environmentId },
      responses: { 200: json(EnvironmentView, "The Environment") },
    },
    async (c) =>
      jsonResponse(
        200,
        await getEnvironment(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope")),
      ),
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environments/{environmentId}/events",
      tags: ["Environments"],
      summary: "Read an Environment's events",
      description:
        "`environment.created`, `.attached`, `.detached`, `.deleted`, a pod's `.running`, `.suspended`, `.relaunched`, `.lost`, `.reset` and `.failed`, and `environment.egress` for every connection its sandbox opens through egress-gate, naming the turns that were running (D67), in order, numbered from 0, at most 1000 per call.",
      request: {
        params: environmentId,
        query: z.object({
          from: z.string().optional().meta({ description: "The first `seq` to return" }),
          types: z.string().optional().meta({ description: "Only these event types, comma-separated (`environment.egress`)" }),
          since: z.string().optional().meta({ description: "Only events recorded at or after this ISO time" }),
          until: z.string().optional().meta({ description: "Only events recorded before this ISO time" }),
        }),
      },
      responses: { 200: json(ListEnvironmentEventsResponse, "The events") },
    },
    async (c) => {
      const from = c.req.query("from");
      if (from !== undefined && !/^\d+$/.test(from)) fail(400, "from must be a seq");
      const types = c.req.query("types")?.split(",").map((type) => type.trim()).filter(Boolean);
      const unknown = types?.find((type) => !(ENVIRONMENT_EVENT_TYPES as readonly string[]).includes(type));
      if (unknown !== undefined) fail(400, `types: ${unknown} is not an Environment event type`);
      const time = (name: "since" | "until") => {
        const value = c.req.query(name);
        if (value === undefined) return undefined;
        const at = Date.parse(value);
        if (!Number.isFinite(at)) fail(400, `${name} must be an ISO time`);
        return new Date(at).toISOString();
      };
      const since = time("since");
      const until = time("until");
      return jsonResponse(
        200,
        await environmentEventsOf(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope"), {
          ...(from === undefined ? {} : { fromSeq: Number(from) }),
          ...(types === undefined || types.length === 0 ? {} : { types }),
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
        }),
      );
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/environments/{environmentId}",
      tags: ["Environments"],
      summary: "Delete an Environment",
      description:
        "Deletes the Environment, its vault with every secret, and its files. Sessions that name it keep its id; their next turn is refused (`environment_unavailable`) until an Environment with this id exists again.",
      request: { params: environmentId },
      responses: {
        200: json(DeleteEnvironmentResponse, "Deleted, or there was none"),
        409: { description: "A session that names it has a turn running (`environment_busy`)" },
      },
    },
    async (c) =>
      jsonResponse(
        200,
        await deleteEnvironment(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope")),
      ),
  );

  for (const [action, summary, description, run] of [
    [
      "stop",
      "Stop a pod Environment",
      "Suspends the pod: its volume is kept, and the next turn of a session that names it starts it again. Refused during a turn (`environment_busy`).",
      stopEnvironment,
    ],
    [
      "reset",
      "Reset a pod Environment",
      "A new pod on a new, empty volume with the recipe applied; the old pod and volume are deleted. The way out of `environment_lost`. Refused during a turn (`environment_busy`).",
      resetEnvironment,
    ],
  ] as const)
    tenantRoute(
      api,
      WRITE,
      {
        method: "post",
        path: `/v1/environments/{environmentId}/${action}`,
        tags: ["Environments"],
        summary,
        description,
        request: { params: environmentId },
        responses: {
          200: json(EnvironmentView, "The Environment"),
          400: { description: "The Environment is not of kind pod" },
          409: {
            description: "A turn holds it (`environment_busy`), or no sandbox pods (`environment_unavailable`)",
          },
        },
      },
      async (c) =>
        jsonResponse(200, await run(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope"))),
    );

  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/environments/{environmentId}/snapshot",
      tags: ["Environments"],
      summary: "Snapshot an Environment's disk",
      description:
        "Between turns, a new version of the Environment's disk (`/workspace`, and a pod's `/harness` but the engine's own files): files with their modes and modification times, links and empty directories, as a version of the folder artifact the Environment owns. Unchanged files are stored once; an unchanged disk makes no version (`unchanged`). A stopped pod is started first. Refused during a turn or another copy (`environment_busy`).",
      request: { params: environmentId },
      responses: {
        201: json(EnvironmentSnapshot, "The version"),
        400: { description: "The Environment is of kind none" },
        409: { description: "A turn or another copy holds the disk (`environment_busy`), or the pod could not start (`environment_unavailable`)" },
        413: { description: "Past the entries, bytes or Tenant total a version may hold (`limit_exceeded`)" },
      },
    },
    async (c) =>
      jsonResponse(201, await snapshotEnvironment(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope"))),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/environments/{environmentId}/restore",
      tags: ["Environments"],
      summary: "Restore a version of an Environment's disk",
      description:
        "Puts disk version `version` (or `latest`) back. A virtual Environment's workspace is rewritten at once (`done`); a pod gets a new volume seeded from the version before any turn (`pending`, with `disk.operation` in the view until it ends). The Environment keeps its id, vault and sessions. Refused during a turn or another copy (`environment_busy`).",
      request: {
        params: environmentId,
        body: { required: true, content: { "application/json": { schema: RestoreEnvironmentRequest } } },
      },
      responses: {
        200: json(EnvironmentRestore, "Restored, or being restored"),
        404: { description: "No such Environment, or no such version" },
        409: { description: "A turn or another copy holds the disk (`environment_busy`)" },
      },
    },
    async (c) => {
      const body = RestoreEnvironmentRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(
        200,
        await restoreEnvironment(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope"), body.version),
      );
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/environments/{environmentId}/fork",
      tags: ["Environments"],
      summary: "Fork an Environment",
      description:
        "How an Environment gets a new manifest version (Q15): a new Environment `id`, made from `manifest` (default the source's manifest at its latest version), its disk started from a version of this one's (`disk`: `latest`, the default, takes a snapshot first; a version number; or `empty`) and its secrets copied inside the Runtime (`secrets`: `copy`, the default, copies those the new manifest declares; `none`). On a fork onto other setup the new manifest's setup runs on the copied disk before its first turn. This Environment keeps what it runs, its disk and its sessions. `dryRun` answers the plan and makes nothing.",
      request: {
        params: environmentId,
        body: { required: true, content: { "application/json": { schema: ForkEnvironmentRequest } } },
      },
      responses: {
        200: json(ForkEnvironmentResponse, "The plan (`dryRun`)"),
        201: json(ForkEnvironmentResponse, "The new Environment, and the plan it ran"),
        400: { description: "The source was made from inline fields and no manifest is named, or the manifest does not resolve" },
        404: { description: "No such Environment, manifest version (`manifest_not_found`) or disk version" },
        409: { description: "The id exists, or a turn or another copy holds the source's disk (`environment_busy`)" },
      },
    },
    async (c) => {
      const body = ForkEnvironmentRequestSchema.parse(await readJson(c.req.raw));
      const answer = await forkEnvironment(c.env.tenant, idOf(c.req.param("environmentId")), body, c.get("scope"));
      return jsonResponse("dryRun" in answer ? 200 : 201, answer);
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environments/{environmentId}/versions",
      tags: ["Environments"],
      summary: "List an Environment's disk versions",
      description:
        "Newest first. Read a version's tree, files, diff and zip through `/v1/artifacts/{artifactId}/versions/{version}/…`.",
      request: { params: environmentId },
      responses: { 200: json(EnvironmentVersions, "The versions") },
    },
    async (c) =>
      jsonResponse(200, await environmentVersions(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope"))),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/environments/{environmentId}/versions/{version}",
      tags: ["Environments"],
      summary: "Delete an Environment's disk version",
      description: "Deletes the version, and the stored files no other version names. Refused while a seed reads it.",
      request: { params: environmentId.extend({ version: z.string() }) },
      responses: {
        200: json(z.object({ environmentId: z.string(), version: z.number(), deleted: z.boolean() }), "Deleted, or there was none"),
        409: { description: "A new volume is being seeded from it (`environment_busy`)" },
      },
    },
    async (c) => {
      const version = c.req.param("version") ?? "";
      if (!/^[1-9]\d{0,8}$/.test(version)) fail(400, "version must be a version number");
      return jsonResponse(
        200,
        await deleteEnvironmentVersion(c.env.tenant, idOf(c.req.param("environmentId")), c.get("scope"), Number(version)),
      );
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environments/{environmentId}/secrets",
      tags: ["Environments"],
      summary: "List an Environment's secrets",
      description: "Each secret's name, type and binding (its URL, or its hosts and header). Never a value.",
      request: { params: environmentId },
      responses: { 200: json(ListEnvironmentSecretsResponse, "The secrets") },
    },
    async (c) => {
      const id = idOf(c.req.param("environmentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, { secrets: await c.env.tenant.vault.listEnvironmentSecrets(id) });
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/environments/{environmentId}/secrets/{name}",
      tags: ["Environments"],
      summary: "Get an Environment's secret",
      description: "Its name, type and binding. Never its value.",
      request: { params: secretPath },
      responses: { 200: json(EnvironmentSecretView, "The secret") },
    },
    async (c) => {
      const id = idOf(c.req.param("environmentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, await c.env.tenant.vault.getEnvironmentSecret(id, c.req.param("name") ?? ""));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/environments/{environmentId}/secrets/{name}",
      tags: ["Environments"],
      summary: "Write an Environment's secret",
      description:
        "Creates or replaces one credential of the Environment's vault: an `environment_secret` (the variable `name` reads the sentinel `nylorun_managed` in the sandbox, and egress-gate sets the value as a header on requests to `allowedHosts`), an `environment_variable` (a plain variable), or a `bearer` token or `headers` map for the MCP servers and HTTP tools at `url`. The same name and type re-seals the value and binding; another type replaces it. A rotated value is used from the next request. A second credential for a host or a URL is `409 credential_conflict`. When what the Environment runs declares secret slots (protocol 14, D64), send only the value (`{ value }`, or `{ headers }` for a `headers` slot): the type and binding come from the slot, and a name it does not declare is `409 secret_not_in_manifest`.",
      request: {
        params: secretPath,
        body: {
          required: true,
          content: { "application/json": { schema: z.union([PutEnvironmentSecretRequest, PutEnvironmentSecretValueRequest]) } },
        },
      },
      responses: {
        200: json(EnvironmentSecretView, "The secret, without its value"),
        409: { description: "Another credential is bound to one of its hosts or to its URL (`credential_conflict`)" },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("environmentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      const name = c.req.param("name") ?? "";
      const body = await secretRequestFor(c.env.tenant, id, name, await readJson(c.req.raw));
      return jsonResponse(200, await c.env.tenant.keys.putEnvironmentSecret(id, name, body, actorOf(scope)));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/environments/{environmentId}/secrets/{name}",
      tags: ["Environments"],
      summary: "Delete an Environment's secret",
      description: "The next request that would have used it gets none.",
      request: { params: secretPath },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      const id = idOf(c.req.param("environmentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      return jsonResponse(
        200,
        await c.env.tenant.vault.deleteEnvironmentSecret(id, c.req.param("name") ?? "", actorOf(scope)),
      );
    },
  );
}
