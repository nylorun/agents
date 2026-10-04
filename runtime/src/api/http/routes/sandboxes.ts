/**
 * Sandboxes as a resource (`/v1/sandboxes/**`, Host feature `sandboxes`): create or find one by
 * id, read it, list them by label, read its lifecycle stream, and delete it. Ids may hold `/`,
 * sent percent-encoded as one path segment (`team-a%2Fproj-42`). A subject token reaches only
 * the ids its `sbx` grants match, and changes them only with `sandboxes:write`.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { isSandboxId, PutSandboxRequestSchema } from "@nylorun/core/contracts";
import {
  DeleteSandboxResponse,
  ListSandboxEventsResponse,
  ListSandboxesResponse,
  SandboxPage,
  PutSandboxRequest,
  SandboxView,
} from "../../components.js";
import { fail } from "../../../tenant/http.js";
import {
  deleteSandbox,
  getSandbox,
  listSandboxes,
  putSandbox,
  resetSandbox,
  sandboxEventsOf,
  stopSandbox,
} from "../../../tenant/sandboxes.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { pageQuery, sandboxPage } from "./reads.js";
import { jsonResponse } from "../respond.js";

/** Reading a sandbox: any caller that may use sessions, or change sandboxes. */
const READ: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own", "sandboxes:write"],
  browser: true,
};
/** Creating or deleting one. */
const WRITE: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sandboxes:write"],
  browser: true,
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const sandboxId = z.object({
  sandboxId: z
    .string()
    .meta({ description: "The sandbox id, percent-encoded: `team-a%2Fproj-42` for `team-a/proj-42`" }),
});

/** The path's sandbox id, or a 400 naming the rule. */
function idOf(value: string | undefined): string {
  if (!isSandboxId(value))
    return fail(
      400,
      "A sandbox id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'",
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

export function sandboxRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/sandboxes",
      tags: ["Sandboxes"],
      summary: "List sandboxes",
      description:
        "Every sandbox with all the labels asked for. A subject token sees only the sandboxes its grants reach.",
      request: {
        query: pageQuery.extend({
          label: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .meta({ description: "`key=value`; repeat it to require several labels" }),
        }),
      },
      responses: { 200: json(z.union([ListSandboxesResponse, SandboxPage]), "The sandboxes; limit opts into pagination") },
    },
    async (c) =>
      jsonResponse(
        200,
        c.req.query("limit") !== undefined
          ? await sandboxPage(c.env.tenant, c.get("scope"), c.req.query(), labelsOf(c.req.queries("label")))
          : await listSandboxes(c.env.tenant, labelsOf(c.req.queries("label")), c.get("scope")),
      ),
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/sandboxes/{sandboxId}",
      tags: ["Sandboxes"],
      summary: "Create or find a sandbox",
      description:
        "Creates the sandbox within the Tenant's limits, or answers the one with this id, so get-or-create is one call. Its spec is fixed once it exists; labels, when sent, replace its labels. Kind `pod` needs sandbox pods (`nylorun sandbox enable`): it is created at once, and a PUT on an existing pod sandbox starts it again when it was stopped, or revives it with a longer `lifecycle.ttl`.",
      request: {
        params: sandboxId,
        body: { required: true, content: { "application/json": { schema: PutSandboxRequest } } },
      },
      responses: {
        200: json(SandboxView, "The sandbox"),
        409: {
          description:
            "A sandbox with this id has another spec, the Tenant holds as many sandboxes as it allows (`limit_exceeded`), kind pod without sandbox pods (`sandbox_unavailable`), or a lost pod sandbox (`sandbox_lost`)",
        },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("sandboxId"));
      const body = PutSandboxRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(200, await putSandbox(c.env.tenant, id, body, c.get("scope")));
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/sandboxes/{sandboxId}",
      tags: ["Sandboxes"],
      summary: "Get a sandbox",
      description: "Its spec, labels, state and the sessions attached to it (acting for a person, only theirs).",
      request: { params: sandboxId },
      responses: { 200: json(SandboxView, "The sandbox") },
    },
    async (c) =>
      jsonResponse(
        200,
        await getSandbox(c.env.tenant, idOf(c.req.param("sandboxId")), c.get("scope")),
      ),
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/sandboxes/{sandboxId}/events",
      tags: ["Sandboxes"],
      summary: "Read a sandbox's lifecycle events",
      description:
        "`sandbox.created`, `sandbox.attached`, `sandbox.detached` and `sandbox.deleted`, in order, numbered from 0.",
      request: {
        params: sandboxId,
        query: z.object({
          from: z.string().optional().meta({ description: "The first `seq` to return" }),
        }),
      },
      responses: { 200: json(ListSandboxEventsResponse, "The events") },
    },
    async (c) => {
      const from = c.req.query("from");
      if (from !== undefined && !/^\d+$/.test(from)) fail(400, "from must be a seq");
      return jsonResponse(
        200,
        await sandboxEventsOf(
          c.env.tenant,
          idOf(c.req.param("sandboxId")),
          c.get("scope"),
          from === undefined ? undefined : Number(from),
        ),
      );
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/sandboxes/{sandboxId}",
      tags: ["Sandboxes"],
      summary: "Delete a sandbox",
      description:
        "Deletes the sandbox and its files. Sessions attached to it stay attached by id; their next turn is refused until a sandbox with this id exists again.",
      request: { params: sandboxId },
      responses: {
        200: json(DeleteSandboxResponse, "Deleted, or there was none"),
        409: { description: "A session attached to it has a turn running (`sandbox_busy`)" },
      },
    },
    async (c) =>
      jsonResponse(
        200,
        await deleteSandbox(c.env.tenant, idOf(c.req.param("sandboxId")), c.get("scope")),
      ),
  );

  for (const [action, summary, description, run] of [
    [
      "stop",
      "Stop a pod sandbox",
      "Suspends the pod: its volume is kept, and the next turn of a session attached to it (or a PUT) starts it again. Refused during a turn (`sandbox_busy`).",
      stopSandbox,
    ],
    [
      "reset",
      "Reset a pod sandbox",
      "A new pod on a new, empty volume; the old pod and volume are deleted. The way out of `sandbox_lost`. Refused during a turn (`sandbox_busy`).",
      resetSandbox,
    ],
  ] as const)
    tenantRoute(
      api,
      WRITE,
      {
        method: "post",
        path: `/v1/sandboxes/{sandboxId}/${action}`,
        tags: ["Sandboxes"],
        summary,
        description,
        request: { params: sandboxId },
        responses: {
          200: json(SandboxView, "The sandbox"),
          400: { description: "The sandbox is virtual" },
          409: { description: "A turn holds it (`sandbox_busy`), or no sandbox pods (`sandbox_unavailable`)" },
        },
      },
      async (c) =>
        jsonResponse(200, await run(c.env.tenant, idOf(c.req.param("sandboxId")), c.get("scope"))),
    );
}
