/**
 * An Agent's triggers and their runs (track T4, D74): read them, pause and resume one, run one now
 * (keyed by `Idempotency-Key`), and page the runs; make a webhook trigger's signing secret, and
 * take a sender's delivery at its endpoint (D75), an anonymous, unversioned route. What a trigger is lives in the Agent's manifest
 * (`runtime.triggers`); these routes change only what the Agent owns, its status.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { isAgentId } from "@nylorun/core/contracts";
import {
  RunTriggerResponse,
  TriggerList,
  TriggerRunPage,
  WebhookAcceptedResponse,
  WebhookSecretResponse,
} from "../../components.js";
import { assertReaches } from "../../../tenant/agents.js";
import { fail } from "../../../tenant/http.js";
import {
  listRuns,
  listTriggers,
  receiveWebhook,
  rotateWebhookSecret,
  runTriggerNow,
  setTriggerStatus,
} from "../../../tenant/triggers.js";
import { readRuntimeLimits } from "../../../tenant/runtime-limits.js";
import { readBytes } from "../body.js";
import type { TenantEnv } from "../app.js";
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
  triggerId: z.string().meta({ description: "The trigger's id in the manifest's `runtime.triggers`" }),
});

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
        "Each trigger its manifest declares, with what the Agent holds of it: its status (`active`, `paused` with a reason, `completed` for an `at` that ran), when it runs next and last ran.",
      request: { params: agentId },
      responses: { 200: json(TriggerList, "The triggers") },
    },
    async (c) => {
      const id = idOf(c.req.param("agentId"));
      assertReaches(c.get("scope"), id);
      return jsonResponse(200, await listTriggers(c.env.tenant, id, originOf(c.req.url)));
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
        return jsonResponse(200, await setTriggerStatus(c.env.tenant, id, c.req.param("triggerId")!, action, originOf(c.req.url)));
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
  credentials: ["application", "subject", "token"],
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
      return jsonResponse(200, await rotateWebhookSecret(c.env.tenant, id, c.req.param("triggerId")!, originOf(c.req.url)));
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
        "A sender's delivery, signed with Standard Webhooks (`webhook-id`, `webhook-timestamp` within 5 minutes by default, `webhook-signature`): no credential and no `Nylorun-Protocol`. The body, any media type, at most the Runtime limit `webhookBodyBytes`, is read as bytes and verified before anything else. It runs the trigger once per `webhook-id`: a retry answers the first run. The body reaches the model as data under the trigger's prompt. Other senders (GitHub, Stripe, Slack) are relayed by an app.",
      request: {
        params: z.object({ endpointId: z.string().meta({ description: "The trigger's endpoint id, `wh_…`" }) }),
        headers: z.object({
          "webhook-id": z.string().optional().meta({ description: "The delivery's id; a retry sends the same" }),
          "webhook-timestamp": z.string().optional().meta({ description: "Seconds since the epoch" }),
          "webhook-signature": z.string().optional().meta({ description: "`v1,<base64>`, space-separated" }),
        }),
        body: {
          required: true,
          description: "The payload, of any media type",
          content: { "*/*": { schema: z.string().meta({ format: "binary" }) } },
        },
      },
      responses: {
        202: json(WebhookAcceptedResponse, "The run it made: started, queued, skipped or failed"),
        401: { description: "Not signed with the endpoint's secret, or a timestamp out of tolerance" },
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

/** The origin a request reached: where its webhook URLs live. */
function originOf(url: string): string {
  return new URL(url).origin;
}
