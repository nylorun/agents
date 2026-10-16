/**
 * Agents (`/v1/agents/**`, protocol 16; Environments from protocol 11, D55, D56): make one from a
 * saved agent manifest or find it by id, read it, list them by label, state or manifest, read its
 * lifecycle stream, stop, reset, fork and delete it, work its disk versions, and write its vault's
 * secrets. Ids may hold `/`, sent percent-encoded as one path segment (`users%2Falice%2Ftriage`).
 * A token caller reaches only the ids its Agent grants match, and changes them only with
 * `agents:write`. Secret values are write-only: no route reads one back.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  AGENT_EVENT_TYPES,
  ForkAgentRequestSchema,
  AGENT_STATES,
  isAgentId,
  PutAgentRequestSchema,
  RestoreAgentRequestSchema,
} from "@nylorun/core/contracts";
import {
  deleteEnvironmentVersion,
  environmentVersions,
  restoreEnvironment,
  snapshotEnvironment,
} from "../../../artifacts/disk.js";
import {
  DeleteAgentResponse,
  DeletedResponse,
  AgentPage,
  AgentRestore,
  AgentSnapshot,
  AgentDiskVersions,
  ForkAgentRequest,
  ForkAgentResponse,
  RestoreAgentRequest,
  AgentSecretView,
  AgentView,
  ListAgentEventsResponse,
  ListAgentSecretsResponse,
  ListAgentsResponse,
  PutAgentDryRunResponse,
  PutAgentRequest,
  PutAgentSecretRequest,
  PutAgentSecretValueRequest,
} from "../../components.js";
import { fail } from "../../../tenant/http.js";
import { canonical } from "../../../store/canonical.js";
import {
  actorOf,
  assertReaches,
  deleteAgent,
  agentEventsOf,
  forkAgent,
  getAgent,
  listAgents,
  planAgentPut,
  putAgent,
  resetAgent,
  secretRequestFor,
  secretWritten,
  stopAgent,
} from "../../../tenant/agents.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { pageQuery, pageSize } from "./reads.js";
import { jsonResponse } from "../respond.js";

/** Reading an Agent: any caller that may read Agents, use sessions, or change Agents. */
const READ: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own", "agents:read", "agents:write"],
};
/** Creating, changing or deleting one, and writing its secrets. */
const WRITE: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["agents:write"],
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const agentId = z.object({
  agentId: z
    .string()
    .meta({ description: "The Agent id, percent-encoded: `users%2Falice%2Ftriage` for `users/alice/triage`" }),
});
const secretPath = agentId.extend({
  name: z.string().meta({
    description: "The secret's name: the variable for `environment_secret` and `environment_variable`, a label for `bearer` and `headers`",
  }),
});

/** The path's Agent id, or a 400 naming the rule. */
function idOf(value: string | undefined): string {
  if (!isAgentId(value))
    return fail(400, "An Agent id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'");
  return value;
}

/**
 * A page cursor: the last Agent id of the page before and the filters it was read with, opaque to
 * the client; a cursor read with other filters is refused.
 */
const cursor = {
  encode: (id: string, filters: object) =>
    Buffer.from(JSON.stringify({ after: id, filters: canonical(filters) })).toString("base64url"),
  decode: (value: string, filters: object): string => {
    try {
      const read = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { after?: unknown; filters?: unknown };
      if (typeof read.after === "string" && read.filters === canonical(filters)) return read.after;
    } catch {}
    return fail(400, "Invalid Agent cursor", { code: "cursor_invalid" });
  },
};

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

export function agentRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents",
      tags: ["Agents"],
      summary: "List Agents",
      description:
        "Every Agent with all the labels asked for, in `state`, made from `manifest` and `outdated` (moving to another version, track T3) when given, by id. A token caller sees only the Agents its grants reach, and a caller acting for a person only that person's sessions on each. `limit` opts into pages.",
      request: {
        query: pageQuery.extend({
          label: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .meta({ description: "`key=value`; repeat it to require several labels" }),
          state: z.string().optional().meta({ description: "Only Agents in this state (`input_required`, …)" }),
          manifest: z.string().optional().meta({ description: "Only Agents made from this agent manifest" }),
          outdated: z
            .enum(["true", "false"])
            .optional()
            .meta({ description: "`true`: only Agents moving to another version of their manifest (waiting for secrets or a start); `false`: only the others" }),
        }),
      },
      responses: {
        200: json(z.union([ListAgentsResponse, AgentPage]), "The Agents; limit opts into pagination"),
      },
    },
    async (c) => {
      const state = c.req.query("state");
      if (state !== undefined && !(AGENT_STATES as readonly string[]).includes(state))
        fail(400, `state must be one of ${AGENT_STATES.join(", ")}`);
      const outdated = c.req.query("outdated");
      if (outdated !== undefined && outdated !== "true" && outdated !== "false") fail(400, "outdated must be true or false");
      const filters = {
        labels: labelsOf(c.req.queries("label")),
        ...(state === undefined ? {} : { state }),
        ...(c.req.query("manifest") === undefined ? {} : { manifest: c.req.query("manifest")! }),
        ...(outdated === undefined ? {} : { outdated: outdated === "true" }),
      };
      const limit = c.req.query("limit");
      if (limit === undefined) {
        const { agents } = await listAgents(c.env.tenant, filters, c.get("scope"));
        return jsonResponse(200, { agents });
      }
      if (!/^[1-9]\d*$/.test(limit)) fail(400, "limit must be a positive integer", { code: "query_invalid" });
      const after = c.req.query("cursor");
      const page = await listAgents(c.env.tenant, filters, c.get("scope"), {
        limit: await pageSize(c.env.tenant, Number(limit)),
        ...(after === undefined ? {} : { after: cursor.decode(after, filters) }),
      });
      return jsonResponse(200, { agents: page.agents, nextCursor: page.next === null ? null : cursor.encode(page.next, filters) });
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/agents/{agentId}",
      tags: ["Agents"],
      summary: "Create, find or move an Agent",
      description:
        "Creates the Agent, its vault and its compute from a saved agent manifest, within the Tenant's limits, or answers the one with this id, so get-or-create is one call. `manifest: \"name\"` records that it tracks the manifest (its latest version, and each version saved later) and `\"name@n\"` that it is pinned; the version it runs is `resolvedVersion`. On an existing one, labels replace, `owner` sets or (with `null`) clears the owner guard, and `manifest` moves it (track T3) with its id, disk, vault and sessions: a harness-only change applies at once (each session's next turn runs it), a runtime change of a pod at its next start (`targetVersion`, `waitingFor: start`), and a version that adds a required secret once a value is set (`waitingFor: secrets`). Its manifest's name, kind, harness and storage are fixed (`409 agent_fixed_field`): fork it to change them. `?dryRun=true` answers the move's plan and changes nothing. Creating an Agent opens no session (D71). Kind `pod` needs sandbox pods (`nylorun local sandbox enable`) and is created at once.",
      request: {
        params: agentId,
        query: z.object({
          dryRun: z.enum(["true", "false"]).optional().meta({ description: "`true`: the plan of moving the existing Agent, with nothing changed" }),
        }),
        body: { required: true, content: { "application/json": { schema: PutAgentRequest } } },
      },
      responses: {
        200: json(z.union([AgentView, PutAgentDryRunResponse]), "The Agent, or with `dryRun` the plan of its move"),
        404: { description: "No agent manifest has this name or version (`manifest_not_found`), or a dry run names no Agent" },
        409: {
          description:
            "A move would change its manifest's name, its kind, harness or storage (`agent_fixed_field`), the Tenant holds as many Agents as it allows (`limit_exceeded`), kind pod without sandbox pods (`agent_unavailable`), or it is being deleted (`agent_busy`)",
        },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      const body = PutAgentRequestSchema.parse(await readJson(c));
      const dryRun = c.req.query("dryRun");
      if (dryRun !== undefined && dryRun !== "true" && dryRun !== "false") fail(400, "dryRun must be true or false");
      if (dryRun === "true") return jsonResponse(200, await planAgentPut(c.env.tenant, id, body, c.get("scope")));
      return jsonResponse(200, await putAgent(c.env.tenant, id, body, c.get("scope")));
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}",
      tags: ["Agents"],
      summary: "Get an Agent",
      description:
        "Its manifest version, what its environment runs, labels, owner guard, derived state with the sessions behind it (`attention`), compute, secret slots, disk, and its sessions (acting for a person, only theirs).",
      request: { params: agentId },
      responses: { 200: json(AgentView, "The Agent") },
    },
    async (c) =>
      jsonResponse(
        200,
        await getAgent(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope")),
      ),
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/events",
      tags: ["Agents"],
      summary: "Read an Agent's events",
      description:
        "`agent.created`, `.attached`, `.detached`, `.deleted`, a pod's `.running`, `.suspended`, `.relaunched`, `.lost`, `.reset` and `.failed`, `.forked`, a move's `.outdated` and `.version_changed` (track T3), and `agent.egress` for every connection its sandbox opens through egress-gate, naming the turns that were running (D67), in order, numbered from 0, at most the Tenant's Runtime limit `environmentEventItems` (default 1000) per call: `from` reads on.",
      request: {
        params: agentId,
        query: z.object({
          from: z.string().optional().meta({ description: "The first `seq` to return" }),
          types: z.string().optional().meta({ description: "Only these event types, comma-separated (`agent.egress`)" }),
          since: z.string().optional().meta({ description: "Only events recorded at or after this ISO time" }),
          until: z.string().optional().meta({ description: "Only events recorded before this ISO time" }),
        }),
      },
      responses: { 200: json(ListAgentEventsResponse, "The events") },
    },
    async (c) => {
      const from = c.req.query("from");
      if (from !== undefined && !/^\d+$/.test(from)) fail(400, "from must be a seq");
      const types = c.req.query("types")?.split(",").map((type) => type.trim()).filter(Boolean);
      const unknown = types?.find((type) => !(AGENT_EVENT_TYPES as readonly string[]).includes(type));
      if (unknown !== undefined) fail(400, `types: ${unknown} is not an Agent event type`);
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
        await agentEventsOf(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope"), {
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
      path: "/v1/agents/{agentId}",
      tags: ["Agents"],
      summary: "Delete an Agent",
      description:
        "Deletes the Agent, its vault with every secret, and its disk. Its sessions keep its id; their next turn is refused (`agent_unavailable`) until an Agent with this id exists again.",
      request: { params: agentId },
      responses: {
        200: json(DeleteAgentResponse, "Deleted, or there was none"),
        409: { description: "One of its sessions has a turn running (`agent_busy`)" },
      },
    },
    async (c) =>
      jsonResponse(
        200,
        await deleteAgent(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope")),
      ),
  );

  for (const [action, summary, description, run] of [
    [
      "stop",
      "Stop a pod Agent",
      "Suspends the pod: its volume is kept, and the next turn of one of its sessions starts it again. Refused during a turn (`agent_busy`).",
      stopAgent,
    ],
    [
      "reset",
      "Reset a pod Agent",
      "A new pod on a new, empty volume with the recipe applied; the old pod and volume are deleted. The way out of `agent_lost`. Refused during a turn (`agent_busy`).",
      resetAgent,
    ],
  ] as const)
    tenantRoute(
      api,
      WRITE,
      {
        method: "post",
        path: `/v1/agents/{agentId}/${action}`,
        tags: ["Agents"],
        summary,
        description,
        request: { params: agentId },
        responses: {
          200: json(AgentView, "The Agent"),
          400: { description: "The Agent is not of kind pod" },
          409: {
            description: "A turn holds it (`agent_busy`), or no sandbox pods (`agent_unavailable`)",
          },
        },
      },
      async (c) =>
        jsonResponse(200, await run(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope"))),
    );

  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/agents/{agentId}/snapshot",
      tags: ["Agents"],
      summary: "Snapshot an Agent's disk",
      description:
        "Between turns, a new version of the Agent's disk (`/workspace`, and a pod's `/harness` but the engine's own files): files with their modes and modification times, links and empty directories, as a version of the folder artifact the Agent owns. Unchanged files are stored once; an unchanged disk makes no version (`unchanged`). A stopped pod is started first. Refused during a turn or another copy (`agent_busy`).",
      request: { params: agentId },
      responses: {
        201: json(AgentSnapshot, "The version"),
        400: { description: "The Agent is of kind none" },
        409: { description: "A turn or another copy holds the disk (`agent_busy`), or the pod could not start (`agent_unavailable`)" },
        413: { description: "Past the entries, bytes or Tenant total a version may hold (`limit_exceeded`)" },
      },
    },
    async (c) =>
      jsonResponse(201, await snapshotEnvironment(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope"))),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/agents/{agentId}/restore",
      tags: ["Agents"],
      summary: "Restore a version of an Agent's disk",
      description:
        "Puts disk version `version` (or `latest`) back. A virtual Agent's workspace is rewritten at once (`done`); a pod gets a new volume seeded from the version before any turn (`pending`, with `disk.operation` in the view until it ends). The Agent keeps its id, vault and sessions. Refused during a turn or another copy (`agent_busy`).",
      request: {
        params: agentId,
        body: { required: true, content: { "application/json": { schema: RestoreAgentRequest } } },
      },
      responses: {
        200: json(AgentRestore, "Restored, or being restored"),
        404: { description: "No such Agent, or no such version" },
        409: { description: "A turn or another copy holds the disk (`agent_busy`)" },
      },
    },
    async (c) => {
      const body = RestoreAgentRequestSchema.parse(await readJson(c));
      return jsonResponse(
        200,
        await restoreEnvironment(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope"), body.version),
      );
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/agents/{agentId}/fork",
      tags: ["Agents"],
      summary: "Fork an Agent",
      description:
        "Copies the Agent into a new one (Q15), which is how an Agent changes what is fixed for its life: a new Agent `id`, made from `manifest` (default the source's manifest name, tracking, at its latest version), its disk started from a version of this one's (`disk`: `latest`, the default, takes a snapshot first; a version number; or `empty`) and its secrets copied inside the Runtime (`secrets`: `copy`, the default, copies those the new manifest declares; `none`). On a fork onto other setup the new manifest's setup runs on the copied disk before its first turn. This Agent keeps what it runs, its disk and its sessions. `dryRun` answers the plan and makes nothing. To move an Agent to another version of the same manifest, with the same kind, harness and storage, `PUT` it instead (track T3).",
      request: {
        params: agentId,
        body: { required: true, content: { "application/json": { schema: ForkAgentRequest } } },
      },
      responses: {
        200: json(ForkAgentResponse, "The plan (`dryRun`)"),
        201: json(ForkAgentResponse, "The new Agent, and the plan it ran"),
        400: { description: "The manifest does not resolve against the Tenant's limits" },
        404: { description: "No such Agent, manifest version (`manifest_not_found`) or disk version" },
        409: { description: "The id exists, or a turn or another copy holds the source's disk (`agent_busy`)" },
      },
    },
    async (c) => {
      const body = ForkAgentRequestSchema.parse(await readJson(c));
      const answer = await forkAgent(c.env.tenant, idOf(c.req.param("agentId")), body, c.get("scope"));
      return jsonResponse("dryRun" in answer ? 200 : 201, answer);
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/versions",
      tags: ["Agents"],
      summary: "List an Agent's disk versions",
      description:
        "Newest first. Read a version's tree, files, diff and zip through `/v1/artifacts/{artifactId}/versions/{version}/…`.",
      request: { params: agentId },
      responses: { 200: json(AgentDiskVersions, "The versions") },
    },
    async (c) =>
      jsonResponse(200, await environmentVersions(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope"))),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/agents/{agentId}/versions/{version}",
      tags: ["Agents"],
      summary: "Delete an Agent's disk version",
      description: "Deletes the version, and the stored files no other version names. Refused while a seed reads it.",
      request: { params: agentId.extend({ version: z.string() }) },
      responses: {
        200: json(z.object({ agentId: z.string(), version: z.number(), deleted: z.boolean() }), "Deleted, or there was none"),
        409: { description: "A new volume is being seeded from it (`agent_busy`)" },
      },
    },
    async (c) => {
      const version = c.req.param("version") ?? "";
      if (!/^[1-9]\d{0,8}$/.test(version)) fail(400, "version must be a version number");
      return jsonResponse(
        200,
        await deleteEnvironmentVersion(c.env.tenant, idOf(c.req.param("agentId")), c.get("scope"), Number(version)),
      );
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/secrets",
      tags: ["Agents"],
      summary: "List an Agent's secrets",
      description: "Each secret's name, type and binding (its URL, or its hosts and header). Never a value.",
      request: { params: agentId },
      responses: { 200: json(ListAgentSecretsResponse, "The secrets") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, { secrets: await c.env.tenant.vault.listEnvironmentSecrets(id) });
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/secrets/{name}",
      tags: ["Agents"],
      summary: "Get an Agent's secret",
      description: "Its name, type and binding. Never its value.",
      request: { params: secretPath },
      responses: { 200: json(AgentSecretView, "The secret") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, await c.env.tenant.vault.getEnvironmentSecret(id, c.req.param("name") ?? ""));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/agents/{agentId}/secrets/{name}",
      tags: ["Agents"],
      summary: "Write an Agent's secret",
      description:
        "Creates or replaces one credential of the Agent's vault: an `environment_secret` (the variable `name` reads the sentinel `nylorun_managed` in the sandbox, and egress-gate sets the value as a header on requests to `allowedHosts`), an `environment_variable` (a plain variable), or a `bearer` token or `headers` map for the MCP servers and HTTP tools at `url`. The same name and type re-seals the value and binding; another type replaces it. A rotated value is used from the next request. A second credential for a host or a URL is `409 credential_conflict`. When the Agent's manifest declares secret slots (D64; while it moves to another version, that version's), send only the value (`{ value }`, or `{ headers }` for a `headers` slot): the type and binding come from the slot, and a name it does not declare is `409 secret_not_in_manifest`.",
      request: {
        params: secretPath,
        body: {
          required: true,
          content: { "application/json": { schema: z.union([PutAgentSecretRequest, PutAgentSecretValueRequest]) } },
        },
      },
      responses: {
        200: json(AgentSecretView, "The secret, without its value"),
        409: { description: "Another credential is bound to one of its hosts or to its URL (`credential_conflict`)" },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      const name = c.req.param("name") ?? "";
      const body = await secretRequestFor(c.env.tenant, id, name, await readJson(c));
      const secret = await c.env.tenant.keys.putEnvironmentSecret(id, name, body, actorOf(scope));
      // A move that waited for this secret goes on (track T3).
      await secretWritten(c.env.tenant, id);
      return jsonResponse(200, secret);
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/agents/{agentId}/secrets/{name}",
      tags: ["Agents"],
      summary: "Delete an Agent's secret",
      description: "The next request that would have used it gets none.",
      request: { params: secretPath },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      return jsonResponse(
        200,
        await c.env.tenant.vault.deleteEnvironmentSecret(id, c.req.param("name") ?? "", actorOf(scope)),
      );
    },
  );
}
