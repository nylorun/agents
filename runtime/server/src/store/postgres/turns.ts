/**
 * The turn index (A2A design §9, Host feature `turns`): the `turns` table's writes and the typed
 * queries on it. `Tx.event` calls `indexTurn` for every event it writes, in the same
 * transaction, so a turn's row changes exactly when its log does:
 *
 * - `command.message` starts the turn (`running`), copying in its session's Agent, owner and A2A
 *   context (`info.a2a.contextId`, `api/a2a/routes.ts`); a further message of the same turn
 *   changes nothing;
 * - `command.approve` and `command.respond` set it `running` again, `turn.paused` `paused`;
 * - `turn.completed`, `turn.failed` and `turn.cancelled` end it, with their end facts' `totals`.
 *
 * Each change stamps the row with its transaction (`txid`), which orders the change feed
 * (`reads.ts`). Rows for the turns recorded before the index are backfilled by migration
 * `0040_turn_index_backfill`.
 */
import { and, desc, eq, isNotNull, gte, inArray, sql, type SQL } from "drizzle-orm";
import type { EventType, TurnStatus } from "@nylorun/core/contracts";
import type { Queryable } from "./db.js";
import { sessions, toJson, turns, type TurnRow } from "./schema.js";

/** The events that change a turn's row, and the status each leaves it in. */
export const TURN_EVENT_STATUS: Readonly<Partial<Record<EventType, TurnStatus>>> = {
  "command.message": "running",
  "command.approve": "running",
  "command.respond": "running",
  "turn.paused": "paused",
  "turn.completed": "completed",
  "turn.failed": "failed",
  "turn.cancelled": "cancelled",
};

/** The statuses a turn ends in. */
export const ENDED_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** What `indexTurn` reads of an event: the envelope fields, as `appendEvent` built them. */
export interface IndexedEvent {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly seq: number;
  readonly time: string;
  readonly type: string;
  readonly payload: unknown;
}

/** An ended turn's `totals`, from its end facts, or null when it has none. */
function totalsOf(payload: unknown): { steps: number; tokens: number; costUsd: number } | null {
  const totals = (payload as { totals?: unknown } | null)?.totals as
    | { steps?: unknown; tokens?: unknown; costUsd?: unknown }
    | undefined;
  if (
    typeof totals?.steps !== "number" ||
    typeof totals.tokens !== "number" ||
    typeof totals.costUsd !== "number"
  )
    return null;
  return { steps: totals.steps, tokens: totals.tokens, costUsd: totals.costUsd };
}

/**
 * Writes the change `event` makes to its turn's row, in the event's transaction (the session
 * row is locked). An event without a turn, or of a type that changes none, writes nothing.
 */
export async function indexTurn(db: Queryable, event: IndexedEvent): Promise<void> {
  const status = TURN_EVENT_STATUS[event.type as EventType];
  if (status === undefined || event.turnId === null) return;
  const ended = ENDED_TURN_STATUSES.has(status);
  const totals = ended ? totalsOf(event.payload) : null;
  const insert = sql`
    INSERT INTO ${turns} (
      "session_id", "turn_id", "agent_id", "owner_user_id", "a2a_context_id", "status",
      "started_at", "ended_at", "changed_at", "totals", "first_seq", "last_seq"
    )
    SELECT
      ${sessions.id}, ${event.turnId}, coalesce(${sessions.agentId}, ''), ${sessions.ownerUserId},
      nylorun.doc(${sessions.body})->'info'->'a2a'->>'contextId', ${status},
      ${event.time}, ${ended ? event.time : null}, ${event.time},
      ${totals === null ? null : sql`${toJson(totals)}::text::json`}, ${event.seq}, ${event.seq}
    FROM ${sessions}
    WHERE ${sessions.id} = ${event.sessionId}`;
  // A turn's further messages (a queued batch) leave its row as it is.
  await db.execute(
    event.type === "command.message"
      ? sql`${insert} ON CONFLICT ("session_id", "turn_id") DO NOTHING`
      : sql`${insert} ON CONFLICT ("session_id", "turn_id") DO UPDATE SET
          "status" = excluded."status",
          "ended_at" = excluded."ended_at",
          "changed_at" = excluded."changed_at",
          "totals" = excluded."totals",
          "last_seq" = excluded."last_seq",
          "txid" = pg_current_xact_id()`,
  );
}

/** One turn's row, or undefined when the session never had that turn. */
export async function turnRow(
  db: Queryable,
  sessionId: string,
  turnId: string,
): Promise<TurnRow | undefined> {
  const [row] = await db
    .select()
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.turnId, turnId)));
  return row;
}

/** Which turns `listTurns` reads: one owner's A2A tasks with one Agent (`ListTasks`). */
export interface TurnListQuery {
  readonly ownerUserId: string;
  readonly agentId: string;
  /** Only turns of A2A contexts. */
  readonly a2a: true;
  /** Only this session (one A2A context's). */
  readonly sessionId?: string;
  /** Only these statuses; empty matches none. */
  readonly statuses?: readonly TurnStatus[];
  /** Only turns whose status changed at or after this ISO time. */
  readonly changedSince?: string;
  /** Only turns after this one in the order: the last row of the previous page. */
  readonly after?: { readonly changedAt: string; readonly sessionId: string; readonly turnId: string };
  readonly limit: number;
}

/**
 * The turns `query` names, latest status change first (then by session and turn id, descending),
 * at most `limit`, and how many match without `after` and `limit`.
 */
export async function listTurns(
  db: Queryable,
  query: TurnListQuery,
): Promise<{ turns: TurnRow[]; total: number }> {
  if (query.statuses?.length === 0) return { turns: [], total: 0 };
  const where: SQL[] = [
    eq(turns.ownerUserId, query.ownerUserId),
    eq(turns.agentId, query.agentId),
    isNotNull(turns.a2aContextId),
  ];
  if (query.sessionId !== undefined) where.push(eq(turns.sessionId, query.sessionId));
  if (query.statuses !== undefined) where.push(inArray(turns.status, [...query.statuses]));
  if (query.changedSince !== undefined) where.push(gte(turns.changedAt, query.changedSince));
  const after = query.after;
  // One statement at a time: a transaction runs on one connection.
  const rows = await db
      .select()
      .from(turns)
      .where(
        and(
          ...where,
          after
            ? sql`(${turns.changedAt}, ${turns.sessionId}, ${turns.turnId}) < (${after.changedAt}, ${after.sessionId}, ${after.turnId})`
            : undefined,
        ),
      )
      .orderBy(desc(turns.changedAt), desc(turns.sessionId), desc(turns.turnId))
      .limit(query.limit);
  const [counted] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(turns)
    .where(and(...where));
  return { turns: rows, total: counted?.total ?? 0 };
}
