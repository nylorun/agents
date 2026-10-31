/**
 * The A2A endpoint's routes (`/v1/a2a/agents/{agentId}[/card]`), declared for serving and for
 * the Runtime's OpenAPI document. What each does is in `routes.ts`; the files tasks write are
 * served at `/v1/a2a/files/…` (`../http/routes/artifacts.ts`). The JSON-RPC operations are A2A's
 * (specification 1.0); the document describes the envelope and links the specification and the
 * Nylorun profile v2. `A2A-Extensions` activates the profile's extensions, and the answer echoes
 * the ones activated.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { TenantEnv } from "../http/app.js";
import { bodyLimit, readText } from "../http/body.js";
import { TraceHeaders, tenantRoute } from "../http/define.js";
import { traceContextOf } from "../../traces/ids.js";
import { jsonResponse } from "../http/respond.js";
import { a2aCall, a2aCard } from "./routes.js";
import { A2A_PROFILE_URL, extensionsHeader, parseExtensions } from "./extensions.js";

/** The Runtime's URL as a caller reaches it: `NYLORUN_PUBLIC_URL`, else the request's origin. */
function baseUrlOf(publicUrl: string | undefined, url: string): string {
  return publicUrl ?? new URL(url).origin;
}

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
      .meta({
        description:
          "`SendMessage`, `GetTask`, `CancelTask`, `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig` or `ListTasks`; others answer their A2A error",
      }),
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
  .meta({
    id: "A2aAgentCard",
    description:
      "The agent's A2A card: this Runtime's JSON-RPC interface (A2A 1.0), `streaming: false`, `pushNotifications` when the Runtime has a push secret, and the Nylorun profile v2 extensions, all `required: false`",
  });
const PROFILE = { description: "The Nylorun A2A profile v2", url: A2A_PROFILE_URL };
const ExtensionsHeader = z
  .string()
  .optional()
  .meta({ description: "Comma-separated profile v2 extension URIs to activate; the answer echoes the activated ones" });

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
      externalDocs: PROFILE,
      request: { params: agentId },
      responses: {
        200: { description: "The card", content: { "application/json": { schema: AgentCard } } },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      return jsonResponse(
        200,
        await a2aCard(ctx, scope, c.req.param("agentId")!, baseUrlOf(ctx.config.publicUrl, c.req.url)),
      );
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
        "A2A 1.0 JSON-RPC, for a subject, under the Nylorun profile v2 (Host feature `a2a-profile-v2`). `SendMessage` blocks up to the Runtime limit `a2aWaitMs` (5 minutes by default; then the task is answered still `WORKING`) unless `returnImmediately`; `GetTask` (with `historyLength`), `CancelTask` and `ListTasks`; and the four push notification config methods, plus `configuration.taskPushNotificationConfig` in `SendMessage`: each update is POSTed as one `StreamResponse`, signed with Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature` with the Runtime's `a2a.push.secret`) and `X-A2A-Notification-Token`, at least once, retried for up to 24 hours, to hosts the Runtime allows (`a2a.push.allowHosts` for private ones). A message to a busy context is queued and answered with the task that will take it (`TASK_STATE_SUBMITTED`); `message.metadata.delivery: \"reject\"` asks for `UnsupportedOperationError` (reason `CONTEXT_BUSY`) instead. A message is text, one data part, or text with `raw` files (stored as artifacts of the context's session) and `url` files (fetched by the Runtime), each at most the Runtime limit `inlineFileBytes` (20 MiB by default). An approval, question or connection the task waits for (`AUTH_REQUIRED` or `INPUT_REQUIRED`) is shown under `interactions/v1` and answered on the same task with `{ interactionId, approved }` or `{ interactionId, value }` under that URI in the message's `metadata`; text never approves. Artifacts carry the turn's output and the files it wrote, as `url` parts at `/v1/a2a/files/…` with `files/v1`; the task's metadata carries `progress/v1`, `telemetry/v1` and `effects/v1`. Extension data is answered only for the extensions activated with `A2A-Extensions`. A context is one session per subject, agent and `contextId`; a task is one turn. JSON-RPC errors are answered with 200; limits, scopes and unavailable streams stay HTTP errors. Not served: streaming, `GetExtendedAgentCard`.",
      externalDocs: A2A_SPECIFICATION,
      request: {
        params: agentId,
        query: z.object({
          "A2A-Version": z.string().optional().meta({ description: "Or the `A2A-Version` header: `1.0`" }),
        }),
        body: { required: true, content: { "application/json": { schema: JsonRpcRequest } } },
        headers: TraceHeaders.extend({ "A2A-Extensions": ExtensionsHeader }),
      },
      responses: {
        200: {
          description: "The JSON-RPC answer: a result, or an A2A error",
          headers: z.object({ "A2A-Extensions": ExtensionsHeader }),
          content: { "application/json": { schema: JsonRpcResponse } },
        },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const ctx = c.env.tenant;
      const version = c.env.incoming.headers["a2a-version"];
      const extensions = parseExtensions(c.req.header("a2a-extensions"));
      const trace = traceContextOf(c.req.raw.headers);
      const echo = extensionsHeader(extensions);
      return jsonResponse(
        200,
        await a2aCall(
          ctx,
          scope,
          c.req.param("agentId")!,
          {
            // A message may carry files inline.
            body: async () => readText(c.req.raw, await bodyLimit(ctx, "inline")),
            version: typeof version === "string" ? version : (c.req.query("A2A-Version") ?? null),
            ...(trace ? { trace } : {}),
            extensions,
            baseUrl: baseUrlOf(ctx.config.publicUrl, c.req.url),
          },
          c.env.outgoing,
        ),
        echo ? { "A2A-Extensions": echo } : {},
      );
    },
  );
}
