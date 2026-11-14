/**
 * An Agent's triggers and their runs (track T4, D74): read them, pause and resume one, run one now
 * (keyed by `Idempotency-Key`), and page the runs; make a webhook trigger's signing secret, and
 * take a sender's delivery at its endpoint (D75), an anonymous, unversioned route. What a trigger is lives in the Agent's manifest
 * (`runtime.triggers`), or, for one its agents made with the `triggers` tool (D83), on the Agent:
 * these routes change only what the Agent owns, its status, and delete an agent's trigger.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { isAgentId, TriggerIdSchema, TriggerPutSchema } from "@nylorun/core/contracts";
import {
  DeletedResponse,
  PutTriggerRequest,
  RunTriggerResponse,
  TriggerList,
  TriggerRunPage,
  TriggerView,
  WebhookAcceptedResponse,
  WebhookSecretResponse,
} from "../../components.js";
import { assertReaches } from "../../../tenant/agents.js";
import { fail } from "../../../tenant/http.js";
import {
  deleteTrigger,
  listRuns,
  listTriggers,
  receiveWebhook,
  rotateWebhookSecret,
  runTriggerNow,
  setTriggerStatus,
} from "../../../tenant/triggers.js";
import { readRuntimeLimits } from "../../../tenant/runtime-limits.js";
import { readBytes, readJson } from "../body.js";
import { putTrigger } from "../../../tenant/api-triggers.js";
import type { TenantBindings, TenantEnv } from "../app.js";
import type { AuthScope } from "../../../tenant/context.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { pageQuery, pageSize, parseQuery } from "./reads.js";
import { jsonResponse } from "../respond.js";

const READ: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own", "agents:read", "agents:write"],
};
const WRITE: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["agents:write"],
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const agentId = z.object({
  agentId: z.string().meta({ description: "The Agent id, percent-encoded" }),
});
const triggerPath = agentId.extend({
  triggerId: z.string().meta({ description: "The trigger's id: in the manifest's `runtime.triggers`, or the one its agent gave it" }),
});

/** Who a route call acts as, for the Agent's events: the principal (its subject), or the token's subject. */
function principalOf(scope: AuthScope): string | undefined {
  if (scope.kind === "token") return `${scope.issuer}:${scope.subject}`;
  if (scope.kind === "subject") return `${scope.principalId}:${scope.subject}`;
  return "principalId" in scope ? scope.principalId : undefined;
}

function idOf(value: string | undefined): string {
  if (!isAgentId(value))
    return fail(400, "An Agent id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'");
  return value;
}

export function triggerRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/triggers",
      tags: ["Triggers"],
      summary: "List an Agent's triggers",
      description:
        "Each trigger its manifest declares, each its agents made with the `triggers` tool (`origin: agent`, with the title and the session that made it), and each a client put over the API (`origin: api`, with the title and the `principal` that put it), with what the Agent holds of it: its status (`active`, `paused` with a reason, `completed` for an `at` that ran), its prompt, when it runs next and last ran. A session's booked wake is not listed.",
      request: { params: agentId },
      responses: { 200: json(TriggerList, "The triggers") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, await listTriggers(c.env.tenant, id, originOf(c)));
    },
  );

  for (const action of ["pause", "resume"] as const)
    tenantRoute(
      api,
      WRITE,
      {
        method: "post",
        path: `/v1/agents/{agentId}/triggers/{triggerId}/${action}`,
        tags: ["Triggers"],
        summary: action === "pause" ? "Pause a trigger" : "Resume a trigger",
        description:
          action === "pause"
            ? "It stops firing until it is resumed; a run already started or queued goes on."
            : "It fires again from its next time after now; missed times are not run. An `at` whose time has passed is refused (`trigger_expired`).",
        request: { params: triggerPath },
        responses: {
          200: json(TriggerList, "The Agent's triggers"),
          409: { description: "An `at` whose time has passed (`trigger_expired`)" },
        },
      },
      async (c) => {
        const id = idOf(c.req.param("agentId"));
        assertReaches(c.get("scope"), id);
        return jsonResponse(200, await setTriggerStatus(c.env.tenant, id, c.req.param("triggerId")!, action, originOf(c)));
      },
    );

  tenantRoute(
    api,
    WRITE,
    {
      method: "put",
      path: "/v1/agents/{agentId}/triggers/{triggerId}",
      tags: ["Triggers"],
      summary: "Put a trigger on an Agent",
      description:
        "Creates or replaces the Agent's trigger `triggerId` of origin `api`: a `Trigger` exactly as a definition's `runtime.triggers` entry holds it (one of `schedule` with `timezone`, `at` or `webhook`; `session`; `prompt`), and an optional `title`. A new one is active with its next time; a replaced one gets its next time again and keeps its status, so a paused one stays paused. The same body again changes nothing and records no event. The checks and limits are a definition's; `runtime.limits.triggers.count` covers the triggers the Agent's agents made and those put here. Upgrades never touch it; `DELETE` removes it. Records `agent.trigger_created` or `agent.trigger_updated` (with `changed`) on the Agent's events. Host feature `api-triggers`.",
      request: {
        params: triggerPath,
        body: { required: true, content: { "application/json": { schema: PutTriggerRequest } } },
      },
      responses: {
        200: json(TriggerView, "The trigger, as the list shows it"),
        400: { description: "Not a trigger, or one the checks refuse: a bad cron or time zone, runs closer than the minimum interval, an `at` not in the future, a prompt too long" },
        404: { description: "No such Agent" },
        409: { description: "The definition declares this id, or an agent's trigger or a booked wake holds it (`trigger_conflict`)" },
        422: { description: "The Agent holds as many triggers its agents or clients made as `limits.triggers.count` allows (`trigger_limit`)" },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      const triggerId = TriggerIdSchema.safeParse(c.req.param("triggerId"));
      if (!triggerId.success) fail(400, triggerId.error.issues[0]?.message ?? "Not a trigger id");
      const body = TriggerPutSchema.safeParse(await readJson(c));
      if (!body.success)
        fail(400, body.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "), {
          code: "invalid_request",
        });
      return jsonResponse(200, await putTrigger(c.env.tenant, id, triggerId.data!, body.data!, principalOf(scope), originOf(c)));
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "delete",
      path: "/v1/agents/{agentId}/triggers/{triggerId}",
      tags: ["Triggers"],
      summary: "Delete a trigger an agent made or a client put",
      description:
        "Deletes a trigger one of the Agent's agents made with the `triggers` tool (`origin: agent`) or a client put (`origin: api`), with `agent.trigger_deleted` on the Agent's events; its runs stay. A trigger its manifest declares is refused (`trigger_from_manifest`): save a version without it, or pause it.",
      request: { params: triggerPath },
      responses: {
        200: json(DeletedResponse, "Deleted"),
        404: { description: "The Agent has no such trigger" },
        409: { description: "The manifest declares it (`trigger_from_manifest`)" },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      const scope = c.get("scope");
      assertReaches(scope, id);
      const triggerId = c.req.param("triggerId")!;
      await deleteTrigger(c.env.tenant, id, triggerId, principalOf(scope));
      return jsonResponse(200, { id: triggerId });
    },
  );

  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/agents/{agentId}/triggers/{triggerId}/run",
      tags: ["Triggers"],
      summary: "Run a trigger now",
      description:
        "Runs it once now, paused or not, as if it had fired: a turn on its session, or a queued message when a turn runs there. A retried request with the same `Idempotency-Key` answers the same run.",
      request: {
        params: triggerPath,
        headers: z.object({ "Idempotency-Key": z.string().min(1).max(200) }),
      },
      responses: { 200: json(RunTriggerResponse, "The run") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      const key = c.req.header("idempotency-key")?.trim();
      if (!key || key.length > 200) fail(400, "Idempotency-Key is required: 1-200 characters");
      return jsonResponse(200, { run: await runTriggerNow(c.env.tenant, id, c.req.param("triggerId")!, key!) });
    },
  );

  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/agents/{agentId}/runs",
      tags: ["Triggers"],
      summary: "List an Agent's runs",
      description:
        "Each time one of its triggers fired or was run by hand, newest first: when it was due, whether it was late, and what came of it (`started`, `queued`, `skipped` or `failed`, with a reason), with the session and turn.",
      request: {
        params: agentId,
        query: pageQuery.extend({
          triggerId: z.string().optional().meta({ description: "Only this trigger's runs" }),
        }),
      },
      responses: { 200: json(TriggerRunPage, "A page of runs") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      const triggerId = c.req.query("triggerId");
      const { limit, cursor } = parseQuery(pageQuery, { limit: c.req.query("limit"), cursor: c.req.query("cursor") });
      return jsonResponse(
        200,
        await listRuns(c.env.tenant, id, {
          ...(triggerId ? { triggerId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: await pageSize(c.env.tenant, limit, { fallback: 50 }),
        }),
      );
    },
  );
}

/** A delivery: no credential, no protocol header, any body; the endpoint id and the signature are the grant. */
const DELIVERY: RouteAccess = {
  credentials: [],
  scopes: "any",
  anonymous: true,
  unversioned: true,
  bytes: true,
};

export function webhookRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    WRITE,
    {
      method: "post",
      path: "/v1/agents/{agentId}/triggers/{triggerId}/secret",
      tags: ["Triggers"],
      summary: "Make a webhook trigger's signing secret",
      description:
        "A new Standard Webhooks secret (`whsec_…`) for a webhook trigger, shown this once; the one before stops working at once. Give it to the sender with the trigger's `webhookUrl`.",
      request: { params: triggerPath },
      responses: {
        200: json(WebhookSecretResponse, "The secret, this once"),
        400: { description: "Not a webhook trigger" },
      },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, await rotateWebhookSecret(c.env.tenant, id, c.req.param("triggerId")!, originOf(c)));
    },
  );

  tenantRoute(
    api,
    DELIVERY,
    {
      method: "post",
      path: "/v1/webhooks/{endpointId}",
      tags: ["Triggers"],
      summary: "Deliver to a webhook trigger",
      description:
        "A sender's delivery, signed with Standard Webhooks (`webhook-id`, `webhook-timestamp` within 5 minutes by default, `webhook-signature`): no credential (an `Authorization` header is ignored) and no `Nylorun-Protocol`. The body, any media type, at most the Runtime limit `webhookBodyBytes`, is read as bytes and verified before anything else. It runs the trigger once per `webhook-id`: a retry answers the first run. The body reaches the model as data under the trigger's prompt. Other senders (GitHub, Stripe, Slack) are relayed by an app.",
      request: {
        params: z.object({ endpointId: z.string().meta({ description: "The trigger's endpoint id, `wh_…`" }) }),
        headers: z.object({
          "webhook-id": z.string().meta({ description: "The delivery's id; a retry sends the same" }),
          "webhook-timestamp": z.string().meta({ description: "Seconds since the epoch" }),
          "webhook-signature": z.string().meta({ description: "`v1,<base64>`, space-separated" }),
        }),
        body: {
          required: true,
          description: "The payload, of any media type",
          content: { "*/*": { schema: z.string().meta({ format: "binary" }) } },
        },
      },
      responses: {
        202: json(WebhookAcceptedResponse, "The run it made: started, queued, skipped or failed"),
        401: { description: "Unsigned, not signed with the endpoint's secret, or a timestamp out of tolerance" },
        404: { description: "No endpoint has this id" },
        409: { description: "The trigger is paused (`trigger_paused`)" },
        413: { description: "Over `webhookBodyBytes`" },
      },
    },
    async (c) => {
      const tenant = c.env.tenant;
      const { webhookBodyBytes } = await tenant.store.tx((t) => readRuntimeLimits(t));
      const body = await readBytes(c.req.raw, webhookBodyBytes, "webhookBodyBytes");
      const header = (name: string) => c.req.header(name)?.trim() || undefined;
      return jsonResponse(
        202,
        await receiveWebhook(tenant, c.req.param("endpointId")!, {
          id: header("webhook-id"),
          timestamp: header("webhook-timestamp"),
          signature: header("webhook-signature"),
          contentType: header("content-type"),
          body,
        }),
      );
    },
  );
}

/**
 * Where its webhook URLs live: the Runtime's public URL (`NYLORUN_PUBLIC_URL`), else the origin
 * the request reached, which behind a proxy that rewrites `Host` is the Runtime's own.
 */
function originOf(c: { readonly req: { readonly url: string }; readonly env: TenantBindings }): string {
  return c.env.tenant.config.publicUrl ?? new URL(c.req.url).origin;
}
