/**
 * `GET /v1/runs/stream` (D83): the Tenant's runs stream, every run of every Agent's triggers as
 * server-sent events from a cursor (`tenant/runs-stream.ts`). For an application credential that
 * reads Agents; a run may arrive twice, and a reader drops a run id it has seen.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { TenantRunEvent } from "../../components.js";
import { streamRuns } from "../../../tenant/runs-stream.js";
import { requestCursor } from "../../../tenant/session-streams.js";
import type { TenantEnv } from "../app.js";
import { tenantRoute, type RouteAccess } from "../define.js";

const READ: RouteAccess = { credentials: ["application"], scopes: ["agents:read", "agents:write"] };

export function runRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    READ,
    {
      method: "get",
      path: "/v1/runs/stream",
      tags: ["Triggers"],
      summary: "Follow the Tenant's runs",
      description:
        "Server-sent events, one `event: run` per run of any Agent's triggers, with its cursor as `id`, from the cursor on (`?cursor=` or `Last-Event-ID`; none reads from the oldest run the stream keeps, 7 days). The data is `{cursor, run}`: the run as the Agent's runs list it, with its Agent and its trigger's origin and title. A run may arrive twice: drop a `runId` you have seen. A cursor from before the Tenant's reset is refused (`cursor_expired`): read again without one. A `: keepalive` comment every 15 seconds.",
      request: {
        query: z.object({
          cursor: z.string().optional().meta({ description: "The cursor of the last run read: the stream goes on after it" }),
        }),
      },
      responses: {
        200: { description: "The runs", content: { "text/event-stream": { itemSchema: TenantRunEvent } } },
        400: { description: "Not a cursor of the runs stream (`invalid_cursor`)" },
        410: { description: "A cursor from before the Tenant's reset (`cursor_expired`)" },
      },
    },
    async (c) => {
      const url = new URL(c.req.url);
      await streamRuns(c.env.tenant, c.env.incoming, c.env.outgoing, requestCursor(c.env.incoming, url));
      return RESPONSE_ALREADY_SENT;
    },
  );
}
