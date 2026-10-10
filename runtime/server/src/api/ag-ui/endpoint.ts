/**
 * The AG-UI endpoint's routes (`/v1/ag-ui/agents/{agentId}/**`), declared for serving and for
 * the Runtime's OpenAPI document. What each does is in `routes.ts`; a run and a reattached run
 * stream AG-UI events on the Node response, as server-sent events.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { EventSchemas, MessageSchema, RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { TenantEnv } from "../http/app.js";
import { readJson } from "../http/body.js";
import { tenantRoute, type RouteAccess } from "../http/define.js";
import { jsonResponse } from "../http/respond.js";
import { agUiCaller, cancelRun, reattachRun, startRun, threadMessages } from "./routes.js";
import { sessionIdFor } from "./session-id.js";

/**
 * AG-UI's own schemas (`@ag-ui/core`), as components of the document. They are converted by
 * Zod itself: zod-to-openapi does not know some of the types they use.
 */
const COMPONENTS = {
  AgUiRunAgentInput: RunAgentInputSchema,
  AgUiEvent: EventSchemas,
  AgUiMessage: MessageSchema,
} satisfies Record<string, z.ZodType>;
const ref = (name: keyof typeof COMPONENTS) => ({ $ref: `#/components/schemas/${name}` });

function registerComponents(api: OpenAPIHono<TenantEnv>): void {
  for (const [name, schema] of Object.entries(COMPONENTS)) {
    const { $schema: _dialect, ...component } = z.toJSONSchema(schema, {
      io: "input",
      reused: "inline",
      unrepresentable: "any",
    });
    api.openAPIRegistry.registerComponent("schemas", name, component as never);
  }
}

const FOR_A_PERSON: RouteAccess = {
  credentials: ["subject", "token"],
  scopes: ["sessions:own"],
};
const events = (description: string) => ({
  description,
  content: { "text/event-stream": { itemSchema: ref("AgUiEvent") } },
});
const agentId = z.object({ agentId: z.string() });
const thread = agentId.extend({ threadId: z.string() });
const TAGS = ["AG-UI"];

/** The person the request acts for, who may use the agent. */
function callerOf(c: Context<TenantEnv>) {
  const scope = c.get("scope");
  return { scope, ...agUiCaller(scope, c.req.param("agentId")!) };
}

export function agUiRoutes(api: OpenAPIHono<TenantEnv>): void {
  registerComponents(api);
  tenantRoute(
    api,
    FOR_A_PERSON,
    {
      method: "post",
      path: "/v1/ag-ui/agents/{agentId}",
      tags: TAGS,
      summary: "Run an agent",
      description:
        "For a person, named by a trusted issuer's token or by `Nylorun-Subject`. The thread is one session per person, agent and thread, created on its first run with `forwardedProps.nylorun.session`. The trailing user message starts a turn (its id is the idempotency key); `resume` answers interrupts. A busy session is a `RUN_ERROR` in the stream.",
      request: {
        params: agentId,
        body: {
          required: true,
          content: { "application/json": { schema: ref("AgUiRunAgentInput") } },
        },
      },
      responses: { 200: events("The run's events, from RUN_STARTED to its end") },
    },
    async (c) => {
      const { scope, subject, access } = callerOf(c);
      await startRun(
        c.env.tenant,
        scope,
        c.req.param("agentId")!,
        { subject, access },
        await readJson(c.req.raw),
        c.env.outgoing,
      );
      return RESPONSE_ALREADY_SENT;
    },
  );

  tenantRoute(
    api,
    FOR_A_PERSON,
    {
      method: "get",
      path: "/v1/ag-ui/agents/{agentId}/threads/{threadId}/messages",
      tags: TAGS,
      summary: "Get a thread's messages",
      request: { params: thread },
      responses: {
        200: {
          description: "The thread's messages; none before its first run",
          content: {
            "application/json": { schema: { type: "array", items: ref("AgUiMessage") } },
          },
        },
      },
    },
    async (c) => {
      const { subject, access } = callerOf(c);
      const id = sessionIdFor(subject, c.req.param("agentId")!, c.req.param("threadId")!);
      return jsonResponse(200, await threadMessages(c.env.tenant, id, access));
    },
  );

  tenantRoute(
    api,
    FOR_A_PERSON,
    {
      method: "get",
      path: "/v1/ag-ui/agents/{agentId}/threads/{threadId}/events",
      tags: TAGS,
      summary: "Reattach to a run",
      description: "The rest of a run after a dropped connection, from `Last-Event-ID` or `cursor`.",
      request: {
        params: thread,
        query: z.object({
          cursor: z.string().optional(),
          runId: z.string().optional().meta({ description: "The run to report events as" }),
        }),
      },
      responses: {
        200: events("The run's remaining events"),
        204: { description: "Nothing to send: no run is going, and none ended after the cursor" },
      },
    },
    async (c) => {
      const { scope, subject, access } = callerOf(c);
      const threadId = c.req.param("threadId")!;
      const header = c.env.incoming.headers["last-event-id"];
      await reattachRun(
        c.env.tenant,
        scope,
        access,
        { threadId, id: sessionIdFor(subject, c.req.param("agentId")!, threadId) },
        {
          lastEventId: typeof header === "string" ? header : undefined,
          cursor: c.req.query("cursor"),
          runId: c.req.query("runId"),
        },
        c.env.outgoing,
      );
      return RESPONSE_ALREADY_SENT;
    },
  );

  tenantRoute(
    api,
    FOR_A_PERSON,
    {
      method: "post",
      path: "/v1/ag-ui/agents/{agentId}/threads/{threadId}/cancel",
      tags: TAGS,
      summary: "Cancel a thread's running turn",
      request: { params: thread },
      responses: { 204: { description: "Cancelled" } },
    },
    async (c) => {
      const { scope, subject } = callerOf(c);
      await cancelRun(
        c.env.tenant,
        sessionIdFor(subject, c.req.param("agentId")!, c.req.param("threadId")!),
        scope,
      );
      return new Response(null, { status: 204 });
    },
  );
}
