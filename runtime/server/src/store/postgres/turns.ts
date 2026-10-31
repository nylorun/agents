/**
 * The turn index (A2A design §9, Host feature `turns`): the `turns` table's writes and the typed
 * queries on it. `Tx.event` calls `indexTurn` for every event it writes, in the same
 * transaction, so a turn's row changes exactly when its log does:
 *
 * - `command.message` starts the turn (`running`), copying in its session's Agent, owner and A2A
 *   context (`info.a2a.contextId`, `api/a2a/routes.ts`) and the queued message it took, if any;
 *   a further message of the same turn only adds its queued message;
 * - `command.approve` and `command.respond` set it `running` again, `turn.paused` `paused` with
 *   what its first open interaction asks for (`waitingFor`, profile v2's kinds);
 * - `turn.completed`, `turn.failed` and `turn.cancelled` end it, with their end facts' `totals`.
 *
 * Each change stamps the row with its transaction (`txid`), which orders the change feed
 * (`reads.ts`). Rows for the turns recorded before the index are backfilled by migration
 * `0041_turn_index_backfill`.
 */
import { and, desc, eq, isNotNull, gte, inArray, or, sql, type SQL } from "drizzle-orm";
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

/** What an interaction asks for, as profile v2 names it (`api/a2a/tasks.ts` `interactionOf`). */
export type WaitingFor = "question" | "approval" | "connection";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a `turn.paused` payload's first open interaction asks for, or null. */
export function waitingForOf(payload: unknown): WaitingFor | null {
  const entries = isRecord(payload) && Array.isArray(payload.interactions) ? payload.interactions : [];
  for (const entry of entries) {
    if (!isRecord(entry) || (entry.status !== undefined && entry.status !== "interaction")) continue;
    const interaction = entry.interaction;
    if (!isRecord(interaction) || typeof interaction.id !== "string") continue;
    const metadata = isRecord(interaction.metadata) ? interaction.metadata : undefined;
    if (interaction.kind === "connection" || metadata?.kind === "connection") return "connection";
    return interaction.kind === "approval" ? "approval" : "question";
  }
  return null;
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
  const waitingFor = event.type === "turn.paused" ? waitingForOf(event.payload) : null;
  const queuedMessageId =
    event.type === "command.message" && isRecord(event.payload) && typeof event.payload.queuedMessageId === "string"
      ? event.payload.queuedMessageId
      : undefined;
  const insert = sql`
    INSERT INTO ${turns} (
      "session_id", "turn_id", "agent_id", "owner_user_id", "a2a_context_id", "status",
      "started_at", "ended_at", "changed_at", "totals", "waiting_for", "queued_message_ids",
      "first_seq", "last_seq"
    )
    SELECT
      ${sessions.id}, ${event.turnId}, coalesce(${sessions.agentId}, ''), ${sessions.ownerUserId},
      nylorun.doc(${sessions.body})->'info'->'a2a'->>'contextId', ${status},
      ${event.time}, ${ended ? event.time : null}, ${event.time},
      ${totals === null ? null : sql`${toJson(totals)}::text::json`}, ${waitingFor},
      ${queuedMessageId === undefined ? sql`'{}'::text[]` : sql`ARRAY[${queuedMessageId}]::text[]`},
      ${event.seq}, ${event.seq}
    FROM ${sessions}
    WHERE ${sessions.id} = ${event.sessionId}`;
  // A turn's further messages (a queued batch) add their queued ids and change nothing else.
  await db.execute(
    event.type === "command.message"
      ? sql`${insert} ON CONFLICT ("session_id", "turn_id") DO UPDATE SET
          "queued_message_ids" = ${turns}."queued_message_ids" || excluded."queued_message_ids"`
      : sql`${insert} ON CONFLICT ("session_id", "turn_id") DO UPDATE SET
          "status" = excluded."status",
          "ended_at" = excluded."ended_at",
          "changed_at" = excluded."changed_at",
          "totals" = excluded."totals",
          "waiting_for" = excluded."waiting_for",
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

/** The turn that took queued message `queuedMessageId` of a session, if one did. */
export async function turnOfQueuedMessage(
  db: Queryable,
  sessionId: string,
  queuedMessageId: string,
): Promise<TurnRow | undefined> {
  const [row] = await db
    .select()
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), sql`${queuedMessageId} = ANY(${turns.queuedMessageIds})`))
    .limit(1);
  return row;
}

/** A status a listed turn may have: `paused` narrowed by what it waits for. */
export interface TurnState {
  readonly status: TurnStatus;
  readonly waitingFor?: readonly WaitingFor[];
}

/** Which turns `listTurns` reads: one owner's A2A tasks with one Agent (`ListTasks`). */
export interface TurnListQuery {
  readonly ownerUserId: string;
  readonly agentId: string;
  /** Only turns of A2A contexts. */
  readonly a2a: true;
  /** Only this session (one A2A context's). */
  readonly sessionId?: string;
  /** Only turns in one of these states; empty matches none. */
  readonly states?: readonly TurnState[];
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
  if (query.states?.length === 0) return { turns: [], total: 0 };
  const where: SQL[] = [
    eq(turns.ownerUserId, query.ownerUserId),
    eq(turns.agentId, query.agentId),
    isNotNull(turns.a2aContextId),
  ];
  if (query.sessionId !== undefined) where.push(eq(turns.sessionId, query.sessionId));
  if (query.states !== undefined)
    where.push(
      or(
        ...query.states.map((state) =>
          and(
            eq(turns.status, state.status),
            state.waitingFor === undefined ? undefined : inArray(turns.waitingFor, [...state.waitingFor]),
          ),
        ),
      )!,
    );
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
