/** Read-only sub-resources and opt-in pages. The execution routes retain their contracts. */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { SESSION_STATUSES } from "@nylorun/core/contracts";
import {
  SessionManifestView,
  SessionUsageTotals,
  ModelCallsPage,
  ModelCallExportPage,
} from "../../components.js";
import { readAccess, readStoreOf } from "../../../reads/access.js";
import { requireApplication } from "../../../tenant/auth.js";
import { fail } from "../../../tenant/http.js";
import { sandboxGrantsOf } from "../../../tenant/sandboxes.js";
import type { TenantEnv } from "../app.js";
import { tenantRoute } from "../define.js";
import { jsonResponse } from "../respond.js";

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export const sessionPageQuery = pageQuery
  .extend({
    agentId: z.string().optional(),
    status: z.enum(SESSION_STATUSES).optional(),
    sandboxId: z.string().optional(),
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
  return readStoreOf(ctx).sessions(filters, { limit, cursor }, readAccess(scope));
}
export async function sandboxPage(
  ctx: TenantEnv["Bindings"]["tenant"],
  scope: TenantEnv["Variables"]["scope"],
  query: Record<string, string>,
  labels: Record<string, string>,
) {
  const { limit, cursor } = parseQuery(
    pageQuery.extend({ label: z.string().optional() }).strict(),
    query,
  );
  if (limit === undefined) return fail(400, "Pagination requires limit");
  return readStoreOf(ctx).sandboxes(
    labels,
    { limit, cursor },
    readAccess(scope),
    sandboxGrantsOf(scope),
  );
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
    async (c) =>
      jsonResponse(
        200,
        await readStoreOf(c.env.tenant).manifest(
          c.req.param("sessionId")!,
          readAccess(c.get("scope")),
        ),
      ),
  );
  for (const kind of ["usage", "calls/model"] as const) {
    const query =
      kind === "usage"
        ? turnQuery
        : turnQuery
            .extend({
              limit: z.coerce.number().int().min(1).max(200).default(50),
              cursor: z.string().optional(),
            })
            .strict();
    tenantRoute(
      api,
      { credentials: ["application", "subject"], scopes: ["tenant:settings"] },
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
        const store = readStoreOf(c.env.tenant),
          access = readAccess(c.get("scope")),
          id = c.req.param("sessionId")!;
        if (kind === "usage") {
          const q = parseQuery(turnQuery, c.req.query());
          return jsonResponse(200, await store.usage(id, q.turnId, access));
        }
        const q = parseQuery(
          turnQuery
            .extend({
              limit: z.coerce.number().int().min(1).max(200).default(50),
              cursor: z.string().optional(),
            })
            .strict(),
          c.req.query(),
        );
        return jsonResponse(200, await store.modelCalls(id, q.turnId, q, access));
      },
    );
  }
  const exportQuery = z
    .object({
      after: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    })
    .strict();
  tenantRoute(
    api,
    { credentials: ["application", "subject"], scopes: ["tenant:settings"] },
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
      return jsonResponse(200, await readStoreOf(c.env.tenant).exportModel(q.after, q.limit));
    },
  );
}
