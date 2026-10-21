/**
 * Sessions: the sessions on a Tenant's Agents, their commands, history and live events, and a
 * session's sandbox tools. Agents and their manifests have their own routes (`agents.ts`,
 * `agent-manifests.ts`).
 */
import type { IncomingMessage } from "node:http";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import {
  PutSessionModelRequestSchema,
  PutSessionRequestSchema,
  SessionCommandSchema,
} from "@nylorun/core/contracts";
import { handleSessionSandboxTool, SandboxRouteError } from "../../../core/sandbox-routes.js";
import { traceContextOf } from "../../../traces/ids.js";
import {
  AcceptedResponse,
  QueuedResponse,
  ListSessionsResponse,
  SessionPage,
  HistoryPage,
  SessionEvent,
  PutSessionModelRequest,
  PutSessionRequest,
  SandboxToolOutcome,
  SessionCommand,
  SessionItemsResponse,
  SessionModelView,
  SessionView,
  StreamClosedFrame,
} from "../../components.js";
import { accessOf, requireApplication } from "../../../tenant/auth.js";
import { command } from "../../../tenant/commands.js";
import { loadSession, sessionOf, type TenantContext } from "../../../tenant/context.js";
import type { SessionAccess } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import { agentGrantsOf, sandboxRouteDeps } from "../../../tenant/agents.js";
import { readHistory, requestCursor, streamHolderOf, streamSessionEvents } from "../../../tenant/session-streams.js";
import { listSessions, putSession, sessionView } from "../../../tenant/sessions.js";
import { chooseSessionModel, readSessionModel } from "../../../tenant/session-model.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { TraceHeaders, tenantRoute, type RouteAccess } from "../define.js";
import { pageQuery, pageSize, sessionPage, sessionPageQuery, parseQuery } from "./reads.js";
import { jsonResponse } from "../respond.js";

const OWN_SESSIONS: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own"],
};
/**
 * A session's own model costs what its model costs: the application chooses it (for a subject
 * too), never a token a person's browser holds.
 */
const APP_SESSIONS: RouteAccess = {
  credentials: ["application", "subject"],
  scopes: ["sessions:own"],
};
function refuseToken(scope: { kind: string }): void {
  if (scope.kind === "token")
    fail(403, "A token caller cannot choose a session's model", { code: "scope_required" });
}

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

/**
 * What a message to a busy session does when it says nothing (D76): a protocol 17 client's waits
 * in the queue; a protocol 16 client's is refused, as before.
 */
function deliveryFor(headers: Headers): "queue" | "reject" {
  const protocol = Number(headers.get(PROTOCOL_HEADER)?.trim());
  return Number.isInteger(protocol) && protocol >= 17 ? "queue" : "reject";
}

export function sessionRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    OWN_SESSIONS,
    {
      method: "post",
      path: "/v1/sessions/{sessionId}/commands",
      tags: ["Sessions"],
      summary: "Send a command to a session",
      description:
        "A message starts a turn, or waits in the session's queue while a turn runs or waits (protocol 17; `delivery: \"reject\"` is refused with `409 session_busy` instead); the others answer what the session waits on, or cancel. Idempotent on the command's `idempotencyKey`.",
      request: { params: sessionId, body: body(SessionCommand), headers: TraceHeaders },
      responses: {
        200: json(z.union([AcceptedResponse, QueuedResponse]), "The command, accepted; a message may be queued"),
        409: { description: "A turn is running (`session_busy`), or the session does not wait on this" },
        429: { description: "The session's queue is full (`queue_full`)" },
      },
    },
    async (c) => {
      // A `traceparent` joins the turn to the caller's trace (R7.4); a malformed one is ignored.
      const trace = traceContextOf(c.req.raw.headers);
      return jsonResponse(
        200,
        await command(
          c.env.tenant,
          c.req.param("sessionId")!,
          SessionCommandSchema.parse(await readJson(c)),
          c.get("scope"),
          { ...(trace ? { trace } : {}), delivery: deliveryFor(c.req.raw.headers) },
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
      request: { query: sessionPageQuery },
      responses: { 200: json(z.union([ListSessionsResponse, SessionPage]), "The sessions; limit opts into pagination") },
    },
    async (c) => {
      const scope = c.get("scope");
      if (c.req.query("limit") !== undefined) return jsonResponse(200, await sessionPage(c.env.tenant, scope, c.req.query()));
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
        "Creates the session on an Agent, or answers the one already opened with the same Agent, owner and info. Its Agent (its sandbox and vault) is fixed for its life, and it pins the manifest version the Agent runs. No session is special: an app that keeps one conversation going reuses its id.",
      request: { params: sessionId, body: body(PutSessionRequest) },
      responses: {
        200: json(SessionView, "The session"),
        409: { description: "A session with this id was opened with other parameters" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const request = PutSessionRequestSchema.parse(await readJson(c));
      // Agent code may trust `info`: only an app server sets it.
      if (scope.kind === "token" && request.info !== undefined)
        fail(403, "A token caller cannot set session info", { code: "scope_required" });
      const grants = agentGrantsOf(scope);
      const session = await putSession(
        ctx,
        c.req.param("sessionId")!,
        request,
        accessOf(scope),
        grants === undefined ? {} : { agentGrants: grants },
      );
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
      path: "/v1/sessions/{sessionId}/model",
      tags: ["Sessions"],
      summary: "Get a session's model",
      description:
        "The model the session's next turn uses (feature `session-model`): its own (`source: \"session\"`) while its provider is connected, else the Tenant's (`source: \"tenant\"`). `choice` is the session's own model, kept while its provider is disconnected.",
      request: { params: sessionId },
      responses: { 200: json(SessionModelView, "The session's model") },
    },
    async (c) => {
      const scope = c.get("scope");
      return jsonResponse(200, await readSessionModel(c.env.tenant, c.req.param("sessionId")!, accessOf(scope)));
    },
  );

  tenantRoute(
    api,
    APP_SESSIONS,
    {
      method: "put",
      path: "/v1/sessions/{sessionId}/model",
      tags: ["Sessions"],
      summary: "Choose a session's model",
      description:
        "Chooses one of a connected provider's models for the session's turns (feature `session-model`), in place of the Tenant's model. The Tenant's model and every other session's stay as they are. Only the application sets it, for itself or for a subject: a trusted issuer's token is refused. A turn calls one model, so the choice changes only while no turn runs or waits (`409 session_busy`). A provider that is not connected, or a model its catalog does not list, is `422 request_rejected`.",
      request: { params: sessionId, body: body(PutSessionModelRequest) },
      responses: {
        200: json(SessionModelView, "The session's model"),
        403: { description: "A trusted issuer's token (`scope_required`)" },
        409: { description: "A turn is running or waits (`session_busy`)" },
        422: { description: "The provider is not connected, or the model is not one of its models" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      refuseToken(scope);
      const choice = PutSessionModelRequestSchema.parse(await readJson(c));
      return jsonResponse(
        200,
        await chooseSessionModel(c.env.tenant, c.req.param("sessionId")!, choice, accessOf(scope)),
      );
    },
  );

  tenantRoute(
    api,
    APP_SESSIONS,
    {
      method: "delete",
      path: "/v1/sessions/{sessionId}/model",
      tags: ["Sessions"],
      summary: "Clear a session's model",
      description:
        "Clears the session's own model (feature `session-model`): its next turns use the Tenant's model. Refused while a turn runs or waits (`409 session_busy`).",
      request: { params: sessionId },
      responses: {
        200: json(SessionModelView, "The session's model"),
        403: { description: "A trusted issuer's token (`scope_required`)" },
        409: { description: "A turn is running or waits (`session_busy`)" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      refuseToken(scope);
      return jsonResponse(
        200,
        await chooseSessionModel(c.env.tenant, c.req.param("sessionId")!, undefined, accessOf(scope)),
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
          limit: pageQuery.shape.limit,
          agent: z
            .string()
            .optional()
            .meta({ description: "Only the events of this agent (the root agent, or one it uses as a tool)" }),
        }),
      },
      responses: { 200: json(z.union([SessionItemsResponse, HistoryPage]), "Events up to now; limit returns a bounded page and tail") },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const id = c.req.param("sessionId")!;
      const cursor = await sessionBelow(ctx, c.env.incoming, id, accessOf(scope));
      const { limit: asked } = parseQuery(pageQuery.pick({ limit: true }), { limit: c.req.query("limit") });
      const limit = asked === undefined ? undefined : await pageSize(ctx, asked);
      return jsonResponse(200, await readHistory(ctx, id, cursor, c.req.query("agent"), limit));
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
        "Server-sent events, each with its type as `event` and its cursor as `id`, from the cursor on. Events are on the `nylorun.event/2` envelope, typed by `SessionEvent`; a client ignores a type it does not know. A trusted issuer's token's stream ends with `event: nylorun.closed` when the token expires. A `: keepalive` comment every 15 seconds.",
      request: { params: sessionId, query: resume },
      responses: {
        200: {
          description: "The session's events",
          content: {
            "text/event-stream": {
              itemSchema: z.union([SessionEvent, StreamClosedFrame]),
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
        streamHolderOf(scope),
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
            await readJson(c),
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
