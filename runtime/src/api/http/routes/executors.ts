/**
 * Executors and their Actions, and session commands: the routes an app's executor uses to take
 * work for its agent and hand results back.
 *
 * The executor routes are deprecated: Action endpoints replace them, the Runtime delivering
 * each Action to a URL the app registers.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import {
  RegisterExecutorsRequestSchema,
  SessionCommandSchema,
} from "@nylorun/core/contracts";
import {
  AcceptedResponse,
  ActionClaimRequest,
  ActionClaimResponse,
  ActionHeartbeatRequest,
  ActionHeartbeatResponse,
  DeleteExecutorResponse,
  DeliveryHeartbeatResponse,
  ExecutorNotification,
  ListActionsResponse,
  ListExecutorsResponse,
  RegisterExecutorsRequest,
  RegisterExecutorsResponse,
  SandboxToolOutcome,
  SessionCommand,
} from "../../components.js";
import {
  actionSandboxTool,
  deleteExecutor,
  listExecutors,
  listPendingActions,
  registerExecutors,
  updateAction,
} from "../../../tenant/actions.js";
import { requirePrincipal } from "../../../tenant/auth.js";
import { command } from "../../../tenant/commands.js";
import { deliveryHeartbeat } from "../../../tenant/delivery.js";
import { streamExecutorWork } from "../../../tenant/live.js";
import type { AuthScope } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { executorOf, notExecutor, tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const EXECUTOR: RouteAccess = { credentials: ["executor"], scopes: "never" };
/** An Action's callbacks: its executor's claim, or the delivery token of its Action endpoint. */
const CALLBACK: RouteAccess = { credentials: ["executor", "delivery"], scopes: "never" };

/** Only an executor or a delivery token calls back about an Action. */
function callbackCaller(scope: AuthScope): void {
  if (scope.kind !== "executor" && scope.kind !== "delivery")
    fail(403, "Executor credential required");
}
const APPLICATION: RouteAccess = { credentials: ["application"], scopes: "never" };

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});
const actionId = z.object({ actionId: z.string() });
const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;

export function executorRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    EXECUTOR,
    {
      method: "get",
      path: "/v1/executors/connect",
      tags: ["Executors"],
      deprecated: true,
      summary: "Wait for work",
      description:
        "Server-sent events: `work_available` at once and whenever the executor's agent has pending Actions, then `GET /v1/actions`. A `: keepalive` comment every 15 seconds.",
      responses: {
        200: {
          description: "The executor's work stream",
          content: { "text/event-stream": { itemSchema: ExecutorNotification } },
        },
      },
    },
    (c) => {
      const executor = executorOf(c.get("scope"));
      const { tenant, incoming, outgoing } = c.env;
      streamExecutorWork(tenant.live, incoming, outgoing, executor.tokenHash);
      return RESPONSE_ALREADY_SENT;
    },
  );

  tenantRoute(
    api,
    EXECUTOR,
    {
      method: "get",
      path: "/v1/actions",
      tags: ["Executors"],
      deprecated: true,
      summary: "List pending Actions",
      responses: { 200: json(ListActionsResponse, "The executor's agent's pending Actions") },
    },
    async (c) =>
      jsonResponse(200, await listPendingActions(c.env.tenant, executorOf(c.get("scope")))),
  );

  tenantRoute(
    api,
    CALLBACK,
    {
      method: "post",
      path: "/v1/actions/{actionId}/sandbox/{tool}",
      tags: ["Executors", "Action endpoints"],
      summary: "Run a sandbox tool for an Action being run",
      description:
        "With the Action's delivery token (Action endpoints), the body is the tool's input. " +
        "With an executor key (deprecated), it also carries the claim.",
      request: {
        params: actionId.extend({ tool: z.enum(SANDBOX_TOOLS) }),
        body: body(
          z
            .looseObject({
              claimId: z.string().optional(),
              generation: z.number().int().optional(),
            })
            .meta({ description: "The tool's input, and an executor's claim" }),
        ),
      },
      responses: {
        200: json(SandboxToolOutcome, "The tool's output, or why it failed"),
        409: {
          description: "The claim is stale or expired, or the Action is unavailable",
        },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      callbackCaller(scope);
      return jsonResponse(
        200,
        await actionSandboxTool(
          c.env.tenant,
          scope,
          c.req.param("actionId")!,
          c.req.param("tool")!,
          () => readJson(c.req.raw),
          c.req.raw.signal,
        ),
      );
    },
  );

  tenantRoute(
    api,
    EXECUTOR,
    {
      method: "post",
      path: "/v1/actions/{actionId}/claim",
      tags: ["Executors"],
      deprecated: true,
      summary: "Claim an Action",
      request: { params: actionId, body: body(ActionClaimRequest) },
      responses: {
        200: json(ActionClaimResponse, "The claim"),
        409: { description: "The Action is unavailable, or the claim is stale or expired" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      executorOf(scope);
      const input = await readJson(c.req.raw);
      return jsonResponse(
        200,
        await updateAction(c.env.tenant, scope, c.req.param("actionId")!, "POST", "claim", input),
      );
    },
  );

  tenantRoute(
    api,
    CALLBACK,
    {
      method: "post",
      path: "/v1/actions/{actionId}/heartbeat",
      tags: ["Executors", "Action endpoints"],
      summary: "Keep an Action alive while it runs",
      description:
        "With the delivery token of an Action endpoint that answered 202, extends the delivery " +
        "by a lease and returns a fresh token. With an executor key (deprecated), extends the " +
        "claim named in the body.",
      request: {
        params: actionId,
        body: {
          required: false,
          content: { "application/json": { schema: ActionHeartbeatRequest } },
        },
      },
      responses: {
        200: json(
          z.union([ActionHeartbeatResponse, DeliveryHeartbeatResponse]),
          "The claim's new expiry, or the delivery's new deadline and token",
        ),
        409: {
          description:
            "The Action is unavailable: the claim is stale or expired, or the delivery was cancelled, lost or sent again",
        },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      callbackCaller(scope);
      const id = c.req.param("actionId")!;
      if (scope.kind === "delivery")
        return jsonResponse(200, await deliveryHeartbeat(c.env.tenant, scope, id));
      const input = await readJson(c.req.raw);
      return jsonResponse(200, await updateAction(c.env.tenant, scope, id, "POST", "heartbeat", input));
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "get",
      path: "/v1/executors",
      tags: ["Executors"],
      deprecated: true,
      summary: "List registered executors",
      responses: { 200: json(ListExecutorsResponse, "Each executor and whether it is connected") },
    },
    (c) => {
      notExecutor(c.get("scope"));
      return jsonResponse(200, listExecutors(c.env.tenant));
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "put",
      path: "/v1/executors",
      tags: ["Executors"],
      deprecated: true,
      summary: "Register executors",
      description: "Each executor's token is scoped to its agent. A new token for an agent ends the old token's streams.",
      request: { body: body(RegisterExecutorsRequest) },
      responses: {
        200: json(RegisterExecutorsResponse, "The executors, and which were rotated"),
        409: { description: "Two executors share a token" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      notExecutor(scope);
      return jsonResponse(
        200,
        await registerExecutors(
          c.env.tenant,
          requirePrincipal(scope),
          RegisterExecutorsRequestSchema.parse(await readJson(c.req.raw)),
        ),
      );
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "delete",
      path: "/v1/executors/{agentId}",
      tags: ["Executors"],
      deprecated: true,
      summary: "Remove an agent's executor",
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: json(DeleteExecutorResponse, "The executor was removed") },
    },
    async (c) => {
      notExecutor(c.get("scope"));
      return jsonResponse(200, await deleteExecutor(c.env.tenant, c.req.param("agentId")!));
    },
  );

  tenantRoute(
    api,
    {
      credentials: ["application", "subject", "token", "executor"],
      scopes: ["sessions:own"],
      browser: true,
    },
    {
      method: "post",
      path: "/v1/sessions/{sessionId}/commands",
      tags: ["Sessions"],
      summary: "Send a command to a session",
      description:
        "A message starts a turn; the others answer what the session waits on, or cancel. An executor sends only `action_result`. Idempotent on the command's `idempotencyKey`.",
      request: {
        params: z.object({ sessionId: z.string() }),
        body: body(SessionCommand),
      },
      responses: {
        200: json(AcceptedResponse, "The command, accepted"),
        409: { description: "A turn is running, or the session does not wait on this" },
      },
    },
    async (c) =>
      jsonResponse(
        200,
        await command(
          c.env.tenant,
          c.req.param("sessionId")!,
          SessionCommandSchema.parse(await readJson(c.req.raw)),
          c.get("scope"),
        ),
      ),
  );
}
