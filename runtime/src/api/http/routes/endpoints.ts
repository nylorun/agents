/**
 * Action endpoints: where the Runtime delivers each agent's Actions (design: Action endpoints
 * §4.2). Registered, listed and removed with the application key; no subject reaches them.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { PutEndpointsRequestSchema } from "@nylorun/core/contracts";
import {
  DeleteEndpointResponse,
  EndpointPingResponse,
  ListEndpointsResponse,
  PutEndpointsRequest,
} from "../../components.js";
import { ActionOutcomeSchema } from "@nylorun/core/contracts";
import { ActionOutcome, ActionResultReceipt } from "../../components.js";
import { deliveryResult, pingEndpoint } from "../../../tenant/delivery.js";
import { requireApplication } from "../../../tenant/auth.js";
import { fail } from "../../../tenant/http.js";
import {
  deleteEndpoint,
  listEndpoints,
  putEndpoints,
} from "../../../tenant/endpoints.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const APPLICATION: RouteAccess = { credentials: ["application"], scopes: "never" };

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export function endpointRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    APPLICATION,
    {
      method: "get",
      path: "/v1/endpoints",
      tags: ["Action endpoints"],
      summary: "List Action endpoints",
      description: "Each agent's Action endpoint, with what recent deliveries say about it.",
      responses: { 200: json(ListEndpointsResponse, "The endpoints") },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      return jsonResponse(200, await listEndpoints(c.env.tenant));
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "put",
      path: "/v1/endpoints",
      tags: ["Action endpoints"],
      summary: "Register Action endpoints",
      description:
        "Points the Runtime at the URL that runs each agent's Actions. A new URL starts with no " +
        "health.",
      request: {
        body: { required: true, content: { "application/json": { schema: PutEndpointsRequest } } },
      },
      responses: { 200: json(ListEndpointsResponse, "The registered endpoints") },
    },
    async (c) => {
      const principalId = requireApplication(c.get("scope"));
      return jsonResponse(
        200,
        await putEndpoints(
          c.env.tenant,
          principalId,
          PutEndpointsRequestSchema.parse(await readJson(c.req.raw)),
        ),
      );
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "delete",
      path: "/v1/endpoints/{agentId}",
      tags: ["Action endpoints"],
      summary: "Remove an agent's Action endpoint",
      description: "The agent's pending Actions wait until an endpoint is registered again.",
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(DeleteEndpointResponse, "The endpoint was removed"),
        404: { description: "The agent has no endpoint" },
      },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      return jsonResponse(200, await deleteEndpoint(c.env.tenant, c.req.param("agentId")!));
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "post",
      path: "/v1/endpoints/{agentId}/ping",
      tags: ["Action endpoints"],
      summary: "Ping an agent's Action endpoint",
      description:
        "Sends a signed ping through the endpoint and records what it answers it serves. A " +
        "wrong URL, a tunnel that is down or a handler that does not serve the agent answers 502.",
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(EndpointPingResponse, "What the endpoint serves"),
        404: { description: "The agent has no endpoint" },
        502: { description: "The endpoint did not answer the ping" },
      },
    },
    async (c) => {
      requireApplication(c.get("scope"));
      return jsonResponse(200, await pingEndpoint(c.env.tenant, c.req.param("agentId")!));
    },
  );

  tenantRoute(
    api,
    { credentials: ["delivery"], scopes: "never" },
    {
      method: "post",
      path: "/v1/actions/{actionId}/result",
      tags: ["Action endpoints"],
      summary: "Post the outcome of an Action answered with 202",
      description:
        "Called by an Action endpoint with the Action's delivery token after it answered the " +
        "delivery with 202. The same result again returns the first receipt.",
      request: {
        params: z.object({ actionId: z.string() }),
        body: { required: true, content: { "application/json": { schema: ActionOutcome } } },
      },
      responses: {
        200: json(ActionResultReceipt, "The outcome was recorded"),
        409: {
          description:
            "The delivery was cancelled, lost or sent again, or the Action has another result",
        },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      if (scope.kind !== "delivery") return fail(403, "A delivery token is required");
      return jsonResponse(
        200,
        await deliveryResult(
          c.env.tenant,
          scope,
          c.req.param("actionId")!,
          ActionOutcomeSchema.parse(await readJson(c.req.raw)),
        ),
      );
    },
  );
}
