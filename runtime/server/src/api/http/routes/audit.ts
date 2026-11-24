/**
 * The Tenant's audit (`/v1/tenant/audit`, the Management API): its stream read newest
 * first, and the one event a client writes, Studio's sign-in, which only Studio's own key may
 * record. Every other Tenant event is written by the change it records.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { StudioSignInRequestSchema, TENANT_EVENT_TYPES } from "@nylorun/core/contracts";
import { StudioSignInRequest, TenantAuditPage, TenantEvent } from "../../components.js";
import { auditFilters, readTenantAudit } from "../../../tenant/audit.js";
import { fail } from "../../../tenant/http.js";
import { STUDIO_PRINCIPAL_ID } from "../../../tenant/principals.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";
import { pageQuery, pageSize, parseQuery } from "./reads.js";

/** A management key, acting as itself (Studio's key too), as every `/v1/tenant/*` read. */
const MANAGEMENT: RouteAccess = { credentials: ["management"], scopes: "never" };
/** A page of the audit when the query names none (within the Tenant's `pageItems`). */
const AUDIT_PAGE_DEFAULT = 50;

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export function auditRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "get",
      path: "/v1/tenant/audit",
      tags: ["Audit"],
      summary: "Read the Tenant's audit",
      description: `The Tenant's stream, newest first: ${TENANT_EVENT_TYPES.map((type) => `\`${type}\``).join(", ")}. Each event names who acted (\`principal\`, from the credential of the request that made the change: a key's name, \`<key>:<subject>\`, \`<issuer>:<subject>\`, \`operate\`, or \`host\` for the Runtime itself) and what wrote it (\`source\`), and never holds a secret value. A page holds \`limit\` events (default ${AUDIT_PAGE_DEFAULT}); \`nextCursor\` reads older ones with the same filters. Host feature \`tenant-audit\`.`,
      request: {
        query: pageQuery.extend({
          types: z.string().optional().meta({ description: "Only these event types, comma-separated (`credential.used,key.created`)" }),
          since: z.string().optional().meta({ description: "Only events at or after this ISO time" }),
          until: z.string().optional().meta({ description: "Only events before this ISO time" }),
        }),
      },
      responses: {
        200: json(TenantAuditPage, "A page of the Tenant's events, newest first"),
        400: { description: "An unknown event type, a time that is not ISO, or a cursor read with other filters (`invalid_request`)" },
      },
    },
    async (c) => {
      const { limit, cursor } = parseQuery(pageQuery, { limit: c.req.query("limit"), cursor: c.req.query("cursor") });
      const filters = auditFilters({ types: c.req.query("types"), since: c.req.query("since"), until: c.req.query("until") });
      return jsonResponse(
        200,
        await readTenantAudit(c.env.tenant, {
          ...filters,
          limit: await pageSize(c.env.tenant, limit, { fallback: AUDIT_PAGE_DEFAULT }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "post",
      path: "/v1/tenant/audit/studio-sign-in",
      tags: ["Audit"],
      summary: "Record a Studio sign-in",
      description:
        "Studio's server records that a browser signed in (`studio.signed_in`): on its loopback address, with a login token, or through a sign-in proxy (`forwarded`), and the person's subject when there is one. Only Studio's key (principal `studio`, derived from the admin key) may call it; any other management key is `403`.",
      request: { body: { required: true, content: { "application/json": { schema: StudioSignInRequest } } } },
      responses: {
        201: json(TenantEvent, "The event recorded"),
        403: { description: "Not Studio's key (`request_rejected`)" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      if (scope.kind !== "management" || scope.principalId !== STUDIO_PRINCIPAL_ID)
        return fail(403, "Only Studio's key records a Studio sign-in", { code: "request_rejected" });
      const request = StudioSignInRequestSchema.parse(await readJson(c));
      const event = await c.env.tenant.store.tx((t) =>
        t.tenantEvent(
          "studio.signed_in",
          { method: request.method, ...(request.subject === undefined ? {} : { subject: request.subject }) },
          { principal: STUDIO_PRINCIPAL_ID, source: "studio" },
        ),
      );
      return jsonResponse(201, event);
    },
  );
}
