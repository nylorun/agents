/**
 * `GET /v1/turns` (Host feature `turns`): the turn index's change feed. Turns in the order their
 * transactions changed them, a turn again each time it changes, after `changedAfter` (the
 * `cursor` a page returned); with `sessionId`, one session's, which come in the order they
 * started, since a session runs one turn at a time. An application key reads the whole Tenant,
 * a subject or a token only its own sessions' turns (and a token only its Agents'). A client
 * that missed pushes, or follows many sessions, catches up with one call per interval.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { TurnStatus, TurnSummary as TurnBody } from "@nylorun/core/contracts";
import { TurnChangesPage } from "../../components.js";
import { taskIdOf } from "../../a2a/tasks.js";
import { readAccess, readStoreOf } from "../../../reads/access.js";
import type { TurnRow } from "../../../store/types.js";
import type { TenantEnv } from "../app.js";
import { tenantRoute } from "../define.js";
import { jsonResponse } from "../respond.js";
import { parseQuery } from "./reads.js";

/** A page's size when the query names none, and the most one holds. */
export const TURNS_PAGE_DEFAULT = 100;
export const TURNS_PAGE_MAX = 500;

const turnsQuery = z
  .object({
    changedAfter: z.string().optional().meta({
      description: "The `cursor` a previous page returned: read the changes after it. Absent: from the first turn.",
    }),
    sessionId: z.string().optional().meta({ description: "Only this session's turns." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .meta({
        description: `At most this many turns, up to ${TURNS_PAGE_MAX}; a larger limit gets that many. Default ${TURNS_PAGE_DEFAULT}`,
      }),
  })
  .strict();

/** A turn index row as the API shows it. */
export function turnSummary(row: TurnRow): TurnBody {
  const totals = row.totals as { steps: number; tokens: number; costUsd: number } | null;
  return {
    turnId: row.turnId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    status: row.status as TurnStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    changedAt: row.changedAt,
    totals: totals ? { steps: totals.steps, tokens: totals.tokens, costUsd: totals.costUsd } : null,
    a2a:
      row.a2aContextId === null
        ? null
        : { contextId: row.a2aContextId, taskId: taskIdOf(row.a2aContextId, row.turnId) },
  };
}

export function turnRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    { credentials: ["application", "subject", "token"], scopes: ["sessions:own"] },
    {
      method: "get",
      path: "/v1/turns",
      tags: ["Sessions"],
      summary: "Follow turns as they change",
      description:
        "The turn index's change feed (Host feature `turns`): each turn's status, times, totals and A2A context and task, in the order the turns changed, a turn again each time it changes. Pass the page's `cursor` as `changedAfter` to read on; it is returned even when no turn changed. With `sessionId`, one session's turns, oldest first. An application key reads the whole Tenant; acting for a person, only theirs.",
      request: { query: turnsQuery },
      responses: {
        200: {
          description: "The turns that changed after the cursor",
          content: { "application/json": { schema: TurnChangesPage } },
        },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const q = parseQuery(turnsQuery, c.req.query());
      const page = await readStoreOf(c.env.tenant).turnChanges(
        q.sessionId === undefined ? {} : { sessionId: q.sessionId },
        {
          limit: Math.min(q.limit ?? TURNS_PAGE_DEFAULT, TURNS_PAGE_MAX),
          ...(q.changedAfter === undefined ? {} : { changedAfter: q.changedAfter }),
        },
        readAccess(scope),
      );
      return jsonResponse(200, { ...page, turns: page.turns.map(turnSummary) });
    },
  );
}
