/** Read-only sub-resources and opt-in pages. The execution routes retain their contracts. */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { SESSION_STATUSES, type ModelCall, type SessionUsageTotals as UsageTotals } from "@nylorun/core/contracts";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import {
  SessionManifestView,
  SessionUsageTotals,
  ModelCallsPage,
  ModelCallExportPage,
  ToolCallsPage,
  TurnTrace,
} from "../../components.js";
import { turnTrace } from "../../../traces/read.js";
import { readAccess, readStoreOf } from "../../../reads/access.js";
import { requireApplication, requirePrincipal } from "../../../tenant/auth.js";
import { fail } from "../../../tenant/http.js";
import { readRuntimeLimits } from "../../../tenant/runtime-limits.js";
import type { TenantEnv } from "../app.js";
import { tenantRoute } from "../define.js";
import { jsonResponse } from "../respond.js";

/**
 * Whether a client speaks protocol 18, whose usage reads carry the calls' timing and the cost by
 * token kind. An older client's SDK parses these reads strictly, so it gets them without.
 */
function usageByKind(header: string | undefined): boolean {
  const protocol = Number(header?.trim());
  return Number.isInteger(protocol) && protocol >= 18;
}

/** A session's usage as a protocol 16 or 17 client reads it. */
function totalsBefore18(totals: UsageTotals) {
  const { costSplit: _split, splitCalls: _splitCalls, modelTimeMs: _time, timedCalls: _timed, ...rest } = totals;
  return rest;
}

/** A model call as a protocol 16 or 17 client reads it. */
function callBefore18(call: ModelCall) {
  const { startedAt: _started, endedAt: _ended, usage, ...rest } = call;
  if (usage === null) return { ...rest, usage };
  const { costSplit: _split, ...counts } = usage;
  return { ...rest, usage: counts };
}

/** A page's `limit`, held to the Tenant's Runtime limit `pageItems` (`pageSize`). */
const limitParam = (fallback?: number) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .meta({
      description: `A page holds at most the Tenant's Runtime limit \`pageItems\` (default 200); a larger limit gets that many${fallback === undefined ? "" : `. Default ${fallback}, or that limit when it is lower`}`,
    });
export const pageQuery = z.object({
  limit: limitParam(),
  cursor: z.string().optional(),
});
/** The size of a page of a session's calls when the query names none (within `pageItems`). */
const CALLS_PAGE_DEFAULT = 50;
/** The size of a page of the model call export when the query names none (within `exportPageItems`). */
const EXPORT_PAGE_DEFAULT = 200;

/**
 * The size of a page: `asked`, or, when the query names none, `fallback`, each within the Tenant's
 * Runtime limit `name` (read for each request): a page asked larger holds that many, and its
 * cursor reads on.
 */
export async function pageSize(
  ctx: TenantEnv["Bindings"]["tenant"],
  asked: number | undefined,
  options: { fallback?: number; name?: "pageItems" | "exportPageItems" } = {},
): Promise<number> {
  const name = options.name ?? "pageItems";
  const limit = (await ctx.store.tx((t) => readRuntimeLimits(t)))[name];
  return Math.min(asked ?? options.fallback ?? limit, limit);
}
export const sessionPageQuery = pageQuery
  .extend({
    agentId: z.string().optional(),
    status: z.enum(SESSION_STATUSES).optional(),
    /** Sessions that pinned a version of this agent manifest. */
    manifest: z.string().optional(),
    ownerUserId: z.string().optional(),
  })
  .strict();
export function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query);
  return result.success ? result.data : fail(400, "Invalid read query", { code: "query_invalid" });
}
export async function sessionPage(
  ctx: TenantEnv["Bindings"]["tenant"],
  scope: TenantEnv["Variables"]["scope"],
  query: Record<string, string>,
) {
  const { limit, cursor, ...filters } = parseQuery(sessionPageQuery, query);
  if (limit === undefined) return fail(400, "Pagination requires limit");
  if (filters.ownerUserId !== undefined) requireApplication(scope);
  return readStoreOf(ctx).sessions(filters, { limit: await pageSize(ctx, limit), cursor }, readAccess(scope));
}
export function readRoutes(api: OpenAPIHono<TenantEnv>): void {
  const sessionId = z.object({ sessionId: z.string() });
  const turnQuery = z.object({ turnId: z.string().optional() }).strict();
  tenantRoute(
    api,
    { credentials: ["application", "subject"], scopes: ["agents:read", "agents:write"] },
    {
      method: "get",
      path: "/v1/sessions/{sessionId}/manifest",
      tags: ["Sessions"],
      summary: "Read the session's pinned manifest",
      request: { params: sessionId },
      responses: {
        200: {
          description: "The pinned public manifest",
          content: { "application/json": { schema: SessionManifestView } },
        },
      },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      return jsonResponse(
        200,
        await readStoreOf(c.env.tenant).manifest(
          c.req.param("sessionId")!,
          readAccess(c.get("scope")),
        ),
      );
    },
  );
  const callsQuery = turnQuery
    .extend({
      limit: limitParam(CALLS_PAGE_DEFAULT),
      cursor: z.string().optional(),
    })
    .strict();
  for (const kind of ["usage", "calls/model"] as const) {
    const query = kind === "usage" ? turnQuery : callsQuery;
    // Spend is the application's to show: no subject scope reaches it (`tenant:settings`,
    // which used to, is retired in protocol 8).
    tenantRoute(
      api,
      { credentials: ["application"], scopes: "never" },
      {
        method: "get",
        path: `/v1/sessions/{sessionId}/${kind}`,
        tags: ["Sessions"],
        summary:
          kind === "usage"
            ? "Read a session's recorded model usage"
            : "Page a session's model calls",
        request: { params: sessionId, query },
        responses: {
          200: {
            description: "Recorded usage, including duplicate billed calls",
            content: {
              "application/json": {
                schema: kind === "usage" ? SessionUsageTotals : ModelCallsPage,
              },
            },
          },
        },
      },
      async (c) => {
        requirePrincipal(c.get("scope"));
        const store = readStoreOf(c.env.tenant),
          access = readAccess(c.get("scope")),
          id = c.req.param("sessionId")!,
          current = usageByKind(c.req.header(PROTOCOL_HEADER));
        if (kind === "usage") {
          const q = parseQuery(turnQuery, c.req.query());
          const totals = await store.usage(id, q.turnId, access);
          return jsonResponse(200, current ? totals : totalsBefore18(totals));
        }
        const q = parseQuery(callsQuery, c.req.query());
        const limit = await pageSize(c.env.tenant, q.limit, { fallback: CALLS_PAGE_DEFAULT });
        const page = await store.modelCalls(id, q.turnId, { ...q, limit }, access);
        return jsonResponse(200, current ? page : { ...page, calls: page.calls.map(callBefore18) });
      },
    );
  }
  const toolCallsQuery = turnQuery
    .extend({
      limit: limitParam(CALLS_PAGE_DEFAULT),
      cursor: z.string().optional(),
    })
    .strict();
  // What ran, with what input, how many sends and how it ended (R5.2): the effect journal's tool
  // rows, readable as the model calls are.
  tenantRoute(
    api,
    { credentials: ["application"], scopes: "never" },
    {
      method: "get",
      path: "/v1/sessions/{sessionId}/calls/tool",
      tags: ["Sessions"],
      summary: "Page a session's tool calls",
      request: { params: sessionId, query: toolCallsQuery },
      responses: {
        200: {
          description: "Each tool call in the order it was first sent, with its status and sends",
          content: { "application/json": { schema: ToolCallsPage } },
        },
      },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      const q = parseQuery(toolCallsQuery, c.req.query());
      const limit = await pageSize(c.env.tenant, q.limit, { fallback: CALLS_PAGE_DEFAULT });
      return jsonResponse(
        200,
        await readStoreOf(c.env.tenant).toolCalls(
          c.req.param("sessionId")!,
          q.turnId,
          { ...q, limit },
          readAccess(c.get("scope")),
        ),
      );
    },
  );
  // A turn's spans (R7.5): the same mapping the trace projector posts, from the turn's log rows,
  // with the installation's content opt-ins. Spans carry cost: the application's, as /calls are.
  tenantRoute(
    api,
    { credentials: ["application"], scopes: "never" },
    {
      method: "get",
      path: "/v1/sessions/{sessionId}/turns/{turnId}/trace",
      tags: ["Sessions"],
      summary: "Read a turn's trace",
      description:
        "The turn's spans as OTLP/HTTP JSON (`resourceSpans`), as the Runtime posts them to an OTLP collector: a root span for the turn, a span for each model, tool and egress crossing, ids derived so every read agrees. Post it to a collector's `/v1/traces` to backfill. A turn still running has no root span yet; a turn the session never had has no spans.",
      request: { params: sessionId.extend({ turnId: z.string() }) },
      responses: {
        200: {
          description: "The turn's spans",
          content: { "application/json": { schema: TurnTrace } },
        },
      },
    },
    async (c) => {
      requirePrincipal(c.get("scope"));
      const ctx = c.env.tenant;
      const id = c.req.param("sessionId")!;
      const turnId = c.req.param("turnId")!;
      const events = await readStoreOf(ctx).turnEvents(id, turnId, readAccess(c.get("scope")));
      return jsonResponse(200, await turnTrace(ctx, id, turnId, events));
    },
  );
  const exportQuery = z
    .object({
      after: z.string().optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .meta({
          description: `A page holds at most the Tenant's Runtime limit \`exportPageItems\` (default 1000); a larger limit gets that many. Default ${EXPORT_PAGE_DEFAULT}, or that limit when it is lower`,
        }),
    })
    .strict();
  // The whole Tenant's ledger is the Management API's (protocol 8): a management key, as itself.
  tenantRoute(
    api,
    { credentials: ["management"], scopes: "never" },
    {
      method: "get",
      path: "/v1/tenant/calls/model",
      tags: ["Tenant"],
      summary: "Export committed model calls in safe transaction order",
      request: { query: exportQuery },
      responses: {
        200: {
          description: "An unfiltered resumable ledger page",
          content: { "application/json": { schema: ModelCallExportPage } },
        },
      },
    },
    async (c) => {
      const q = parseQuery(exportQuery, c.req.query());
      const limit = await pageSize(c.env.tenant, q.limit, { fallback: EXPORT_PAGE_DEFAULT, name: "exportPageItems" });
      const page = await readStoreOf(c.env.tenant).exportModel(q.after, limit);
      return jsonResponse(
        200,
        usageByKind(c.req.header(PROTOCOL_HEADER)) ? page : { ...page, calls: page.calls.map(callBefore18) },
      );
    },
  );
}
