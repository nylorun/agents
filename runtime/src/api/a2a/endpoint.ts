/**
 * The A2A endpoint's routes (`/v1/a2a/agents/{agentId}[/card]`), declared for serving and for
 * the Runtime's OpenAPI document. What each does is in `routes.ts`. The JSON-RPC operations are
 * A2A's (specification 1.0); the document describes the envelope and links the specification.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { TenantEnv } from "../http/app.js";
import { readText } from "../http/body.js";
import { tenantRoute } from "../http/define.js";
import { jsonResponse } from "../http/respond.js";
import { a2aCall, a2aCard } from "./routes.js";

const A2A_SPECIFICATION = {
  description: "The A2A specification",
  url: "https://a2a-protocol.org/latest/specification/",
};
const agentId = z.object({ agentId: z.string() });
const TAGS = ["A2A"];

const JsonRpcRequest = z
  .looseObject({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z
      .string()
      .meta({ description: "`SendMessage`, `GetTask` or `CancelTask`; others answer their A2A error" }),
    params: z.unknown().optional(),
  })
  .meta({ id: "A2aJsonRpcRequest" });
const JsonRpcResponse = z
  .looseObject({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .optional(),
  })
  .meta({ id: "A2aJsonRpcResponse" });
const AgentCard = z
  .looseObject({ name: z.string(), description: z.string().optional(), skills: z.array(z.unknown()).optional() })
  .meta({ id: "A2aAgentCard", description: "The agent's A2A card, without interfaces" });

export function a2aRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    {
      credentials: ["application", "subject", "token"],
      scopes: ["agents:read", "sessions:own"],
    },
    {
      method: "get",
      path: "/v1/a2a/agents/{agentId}/card",
      tags: TAGS,
      summary: "Get an agent's A2A card",
      externalDocs: A2A_SPECIFICATION,
      request: { params: agentId },
      responses: {
        200: { description: "The card", content: { "application/json": { schema: AgentCard } } },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      return jsonResponse(200, await a2aCard(c.env.tenant, scope, c.req.param("agentId")!));
    },
  );

  tenantRoute(
    api,
    { credentials: ["subject", "token"], scopes: ["sessions:own"] },
    {
      method: "post",
      path: "/v1/a2a/agents/{agentId}",
      tags: TAGS,
      summary: "Call an agent over A2A",
      description:
        "A2A 1.0 JSON-RPC, for a subject: `SendMessage` (blocking up to 5 minutes, or `returnImmediately`), `GetTask` and `CancelTask`. A context is one session per subject, agent and `contextId`; a task is one turn. JSON-RPC errors are answered with 200; limits, scopes and unavailable streams stay HTTP errors.",
      externalDocs: A2A_SPECIFICATION,
      request: {
        params: agentId,
        query: z.object({
          "A2A-Version": z.string().optional().meta({ description: "Or the `A2A-Version` header: `1.0`" }),
        }),
        body: { required: true, content: { "application/json": { schema: JsonRpcRequest } } },
      },
      responses: {
        200: {
          description: "The JSON-RPC answer: a result, or an A2A error",
          content: { "application/json": { schema: JsonRpcResponse } },
        },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const version = c.env.incoming.headers["a2a-version"];
      return jsonResponse(
        200,
        await a2aCall(
          c.env.tenant,
          scope,
          c.req.param("agentId")!,
          {
            body: () => readText(c.req.raw),
            version: typeof version === "string" ? version : (c.req.query("A2A-Version") ?? null),
          },
          c.env.outgoing,
        ),
      );
    },
  );
}
