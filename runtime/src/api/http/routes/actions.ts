/**
 * Session commands, and the callbacks an Action endpoint makes about the Action it was
 * delivered: heartbeats and sandbox tools, with the Action's delivery token (Action endpoints).
 * The background result is in `endpoints.ts`.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { SessionCommandSchema } from "@nylorun/core/contracts";
import {
  AcceptedResponse,
  DeliveryHeartbeatResponse,
  SandboxToolOutcome,
  SessionCommand,
} from "../../components.js";
import { actionSandboxTool } from "../../../tenant/actions.js";
import { command } from "../../../tenant/commands.js";
import type { AuthScope } from "../../../tenant/context.js";
import { deliveryHeartbeat } from "../../../tenant/delivery.js";
import type { DeliveryScope } from "../../../tenant/delivery-token.js";
import { fail } from "../../../tenant/http.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

/** An Action's callbacks: only the delivery token of its current delivery. */
const CALLBACK: RouteAccess = { credentials: ["delivery"], scopes: "never" };

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

function deliveryOf(scope: AuthScope): DeliveryScope {
  if (scope.kind !== "delivery") return fail(403, "A delivery token is required");
  return scope;
}

export function actionRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    CALLBACK,
    {
      method: "post",
      path: "/v1/actions/{actionId}/sandbox/{tool}",
      tags: ["Action endpoints"],
      summary: "Run a sandbox tool for an Action being delivered",
      description:
        "Called by the Action endpoint with the Action's delivery token. The body is the tool's input.",
      request: {
        params: actionId.extend({ tool: z.enum(SANDBOX_TOOLS) }),
        body: body(z.looseObject({}).meta({ description: "The tool's input" })),
      },
      responses: {
        200: json(SandboxToolOutcome, "The tool's output, or why it failed"),
        409: { description: "The delivery was cancelled, lost or sent again" },
      },
    },
    async (c) =>
      jsonResponse(
        200,
        await actionSandboxTool(
          c.env.tenant,
          deliveryOf(c.get("scope")),
          c.req.param("actionId")!,
          c.req.param("tool")!,
          () => readJson(c.req.raw),
          c.req.raw.signal,
        ),
      ),
  );

  tenantRoute(
    api,
    CALLBACK,
    {
      method: "post",
      path: "/v1/actions/{actionId}/heartbeat",
      tags: ["Action endpoints"],
      summary: "Keep a background delivery alive",
      description:
        "Called by an Action endpoint that answered a delivery with 202: extends the delivery by a " +
        "lease and returns a fresh delivery token.",
      request: { params: actionId },
      responses: {
        200: json(DeliveryHeartbeatResponse, "The delivery's new deadline, and a fresh token"),
        409: { description: "The delivery was cancelled, lost or sent again" },
      },
    },
    async (c) =>
      jsonResponse(
        200,
        await deliveryHeartbeat(c.env.tenant, deliveryOf(c.get("scope")), c.req.param("actionId")!),
      ),
  );

  tenantRoute(
    api,
    {
      credentials: ["application", "subject", "token"],
      scopes: ["sessions:own"],
    },
    {
      method: "post",
      path: "/v1/sessions/{sessionId}/commands",
      tags: ["Sessions"],
      summary: "Send a command to a session",
      description:
        "A message starts a turn; the others answer what the session waits on, or cancel. Idempotent on the command's `idempotencyKey`.",
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
