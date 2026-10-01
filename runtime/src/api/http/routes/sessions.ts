/**
 * Agents and sessions: the definitions a Tenant runs, the sessions of them, their history and
 * live events, and a session's sandbox tools.
 */
import type { IncomingMessage } from "node:http";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { PutAgentRequestSchema, PutSessionRequestSchema } from "@nylorun/core/contracts";
import { handleSessionSandboxTool, SandboxRouteError } from "../../../core/sandbox-routes.js";
import {
  ListAgentsResponse,
  ListPublicAgentsResponse,
  ListSessionsResponse,
  LiveEvent,
  PutAgentRequest,
  PutAgentResponse,
  PutSessionRequest,
  SandboxToolOutcome,
  SessionItemsResponse,
  SessionView,
  StreamClosedFrame,
} from "../../components.js";
import { sandboxRouteDeps } from "../../../tenant/actions.js";
import { accessOf, requireApplication } from "../../../tenant/auth.js";
import { loadSession, sessionOf, type TenantContext } from "../../../tenant/context.js";
import type { SessionAccess } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import { readHistory, requestCursor, streamSessionEvents } from "../../../tenant/session-streams.js";
import {
  listAgentsPublic,
  listDefinitions,
  listSessions,
  putDefinition,
  putSession,
  sessionView,
} from "../../../tenant/sessions.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const OWN_SESSIONS: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own"],
  browser: true,
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});
const sessionId = z.object({ sessionId: z.string() });
const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;
const resume = z.object({
  cursor: z
    .string()
    .optional()
    .meta({ description: "Continue after this event's cursor; `Last-Event-ID` works too" }),
});

function urlOf(incoming: IncomingMessage): URL {
  return new URL(incoming.url ?? "/", "http://runtime");
}

/**
 * A session route below the session itself: the session must exist and be the caller's, and a
 * resume cursor must be well formed, before anything else.
 */
async function sessionBelow(
  ctx: TenantContext,
  incoming: IncomingMessage,
  id: string,
  access: SessionAccess | undefined,
): Promise<string | undefined> {
  await loadSession(ctx, id, access);
  return requestCursor(incoming, urlOf(incoming));
}

export function sessionRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    {
      credentials: ["application", "subject", "token", "publishable"],
      scopes: ["agents:read", "agents:write"],
      browser: true,
    },
    {
      method: "get",
      path: "/v1/agents",
      tags: ["Agents"],
      summary: "List agents",
      description:
        "With an application key, every definition, manifest included. With a subject token or a publishable key, only the agents it may use, by name.",
      responses: {
        200: json(
          z.union([ListAgentsResponse, ListPublicAgentsResponse]),
          "The agents",
        ),
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      if (scope.kind === "publishable")
        return jsonResponse(200, await listAgentsPublic(ctx, scope.agents));
      return jsonResponse(
        200,
        scope.kind === "token"
          ? await listAgentsPublic(ctx, scope.agents)
          : await listDefinitions(ctx),
      );
    },
  );

  tenantRoute(
    api,
    { credentials: ["application", "subject"], scopes: ["agents:write"] },
    {
      method: "put",
      path: "/v1/agents/{agentId}",
      tags: ["Agents"],
      summary: "Put an agent's definition",
      request: { params: z.object({ agentId: z.string() }), body: body(PutAgentRequest) },
      responses: { 200: json(PutAgentResponse, "The definition, stored") },
    },
    async (c) => {
      return jsonResponse(
        200,
        await putDefinition(
          c.env.tenant,
          c.req.param("agentId")!,
          PutAgentRequestSchema.parse(await readJson(c.req.raw)),
        ),
      );
    },
  );

  tenantRoute(
    api,
    OWN_SESSIONS,
    {
      method: "get",
      path: "/v1/sessions",
      tags: ["Sessions"],
      summary: "List sessions",
      description: "Acting for a person, only theirs.",
      request: { query: z.object({ agentId: z.string().optional() }) },
      responses: { 200: json(ListSessionsResponse, "The sessions") },
    },
    async (c) => {
      const scope = c.get("scope");
      return jsonResponse(
        200,
        await listSessions(c.env.tenant, c.req.query("agentId") ?? null, accessOf(scope)),
      );
    },
  );

  tenantRoute(
    api,
    OWN_SESSIONS,
    {
      method: "put",
      path: "/v1/sessions/{sessionId}",
      tags: ["Sessions"],
      summary: "Open a session",
      description:
        "Creates the session, or re-attaches vaults to an identical one. Its sandbox is chosen now and fixed for its life.",
      request: { params: sessionId, body: body(PutSessionRequest) },
      responses: {
        200: json(SessionView, "The session"),
        409: { description: "A session with this id was opened with other parameters" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const request = PutSessionRequestSchema.parse(await readJson(c.req.raw));
      // Agent code may trust `info`: only an app server sets it.
      if (scope.kind === "token" && request.info !== undefined)
        fail(403, "A subject token cannot set session info", { code: "scope_required" });
      const session = await putSession(ctx, c.req.param("sessionId")!, request, accessOf(scope));
      return jsonResponse(200, await ctx.store.tx((t) => sessionView(t, session)));
    },
  );

  tenantRoute(
    api,
    OWN_SESSIONS,
    {
      method: "get",
      path: "/v1/sessions/{sessionId}",
      tags: ["Sessions"],
      summary: "Get a session",
      request: { params: sessionId },
      responses: { 200: json(SessionView, "The session") },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const id = c.req.param("sessionId")!;
      return jsonResponse(
        200,
        await ctx.store.tx(async (t) => sessionView(t, await sessionOf(t, id, accessOf(scope)))),
      );
    },
  );

  tenantRoute(
    api,
    OWN_SESSIONS,
    {
      method: "get",
      path: "/v1/sessions/{sessionId}/items",
      tags: ["Sessions"],
      summary: "Read a session's history",
      request: {
        params: sessionId,
        query: resume.extend({
          agent: z
            .string()
            .optional()
            .meta({ description: "Only the events of this agent (the root agent, or one it uses as a tool)" }),
        }),
      },
      responses: { 200: json(SessionItemsResponse, "Events up to now, and the cursor to continue") },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const id = c.req.param("sessionId")!;
      const cursor = await sessionBelow(ctx, c.env.incoming, id, accessOf(scope));
      return jsonResponse(200, await readHistory(ctx, id, cursor, c.req.query("agent")));
    },
  );

  tenantRoute(
    api,
    OWN_SESSIONS,
    {
      method: "get",
      path: "/v1/sessions/{sessionId}/events",
      tags: ["Sessions"],
      summary: "Follow a session's events",
      description:
        "Server-sent events, each with its cursor as `id`, from the cursor on. A subject token's stream ends with `event: nylorun.closed` when the token expires or the subject is revoked. A `: keepalive` comment every 15 seconds.",
      request: { params: sessionId, query: resume },
      responses: {
        200: {
          description: "The session's events",
          content: {
            "text/event-stream": {
              itemSchema: z.union([LiveEvent, StreamClosedFrame]),
            },
          },
        },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const { incoming, outgoing } = c.env;
      const id = c.req.param("sessionId")!;
      const cursor = await sessionBelow(ctx, incoming, id, accessOf(scope));
      await streamSessionEvents(
        ctx,
        incoming,
        outgoing,
        id,
        cursor,
        scope.kind === "token"
          ? { subject: scope.subject, epoch: scope.epoch, expiresAt: scope.expiresAt }
          : undefined,
      );
      return RESPONSE_ALREADY_SENT;
    },
  );

  tenantRoute(
    api,
    { credentials: ["application"], scopes: "never" },
    {
      method: "post",
      path: "/v1/sessions/{sessionId}/sandbox/{tool}",
      tags: ["Sessions"],
      summary: "Run a sandbox tool in a session",
      description: "For an app's own tools; not while a turn is running.",
      request: {
        params: sessionId.extend({ tool: z.enum(SANDBOX_TOOLS) }),
        body: body(z.looseObject({}).meta({ description: "The tool's input" })),
      },
      responses: {
        200: json(SandboxToolOutcome, "The tool's output, or why it failed"),
        409: { description: "A turn is running" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const id = c.req.param("sessionId")!;
      await sessionBelow(ctx, c.env.incoming, id, accessOf(scope));
      requireApplication(scope);
      try {
        return jsonResponse(
          200,
          await handleSessionSandboxTool(
            sandboxRouteDeps(ctx),
            id,
            c.req.param("tool")!,
            await readJson(c.req.raw),
            c.req.raw.signal,
          ),
        );
      } catch (error) {
        if (error instanceof SandboxRouteError) fail(error.status, error.message);
        throw error;
      }
    },
  );
}
