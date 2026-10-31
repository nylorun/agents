/**
 * A2A tasks read from the turn index (Host feature `turns`): `ListTasks` (A2A 1.0 §3.1.4) and
 * the bounded reads of one turn's events that `GetTask`, `CancelTask` and replies use. A context
 * is listable because `openContext` writes `info.a2a` on its session, which the index copies into
 * each turn's row; nothing here scans a session's whole history.
 *
 * `ListTasks` is scoped before any lookup: the caller's own subject and this endpoint's Agent,
 * A2A contexts only. Tasks come latest status change first; a page's token is the last task's
 * position, bound to the caller and the filters. Each task is built as `GetTask` builds it, from
 * its turn's own events (state, interaction, `progress/v1` and `telemetry/v1` metadata), with
 * `history` only for `historyLength` and artifacts only for `includeArtifacts`; its
 * `status.timestamp` is when its status last changed, which `statusTimestampAfter` compares with.
 * A paused turn is `AUTH_REQUIRED` while it waits for an approval or a connection, and
 * `INPUT_REQUIRED` for a question (the index's `waitingFor`). A queued message no turn took yet
 * (`SUBMITTED`) is not a turn, so it is not listed.
 */
import type { LiveEvent, TurnStatus } from "@nylorun/core/contracts";
import type { TurnState } from "../../store/postgres/turns.js";
import { encodeCursor } from "../../record/index.js";
import { historyCursor, readCursor } from "../../reads/cursor.js";
import type { TurnRow } from "../../store/types.js";
import { ENDED_TURN_STATUSES } from "../../store/postgres/turns.js";
import { loadSession, type Session, type SessionAccess, type TenantContext } from "../../tenant/context.js";
import { HttpError } from "../../tenant/http.js";
import { readHistory } from "../../tenant/session-streams.js";
import { a2aFail, parseHistoryLength, type Task, type TaskState } from "./protocol.js";
import { contextSessionId } from "./tasks.js";

/** `ListTasks`' page size when the request names none, and the most it may ask. */
export const LIST_PAGE_DEFAULT = 50;
export const LIST_PAGE_MAX = 100;

/**
 * The turn index states each A2A state is (profile v2 §1): a paused turn by what its first open
 * interaction asks for. `SUBMITTED` (a queued message), `REJECTED` and anything else: none.
 */
const TURN_STATES: Readonly<Partial<Record<TaskState, readonly TurnState[]>>> = {
  TASK_STATE_WORKING: [{ status: "running" }],
  TASK_STATE_INPUT_REQUIRED: [{ status: "paused", waitingFor: ["question"] }],
  TASK_STATE_AUTH_REQUIRED: [{ status: "paused", waitingFor: ["approval", "connection"] }],
  TASK_STATE_COMPLETED: [{ status: "completed" }],
  TASK_STATE_FAILED: [{ status: "failed" }],
  TASK_STATE_CANCELED: [{ status: "cancelled" }],
};

const TASK_STATES: readonly TaskState[] = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];

/** `ListTasks` params, checked. */
export interface ListParams {
  readonly contextId?: string;
  readonly status?: TaskState;
  /** ISO, normalized to the index's form (`toISOString`). */
  readonly statusTimestampAfter?: string;
  readonly pageSize: number;
  readonly pageToken?: string;
  readonly historyLength?: number;
  readonly includeArtifacts: boolean;
}

/** `ListTasks` result (A2A 1.0): `nextPageToken` is empty on the last page. */
export interface ListTasksResult {
  tasks: Task[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

const VISIBLE = /^[\x21-\x7e]{1,200}$/;
const present = (value: unknown) => value !== undefined && value !== null && value !== "";

/** `ListTasks` params (A2A 1.0 §3.1.4), checked in the order a client can fix them. */
export function parseListParams(params: Record<string, unknown>): ListParams {
  const { contextId, status, statusTimestampAfter, pageSize, pageToken, includeArtifacts } = params;
  if (present(contextId) && (typeof contextId !== "string" || !VISIBLE.test(contextId)))
    a2aFail("invalidParams", "contextId must be 1 to 200 visible ASCII characters", {}, "contextId");
  if (
    present(status) &&
    status !== "TASK_STATE_UNSPECIFIED" &&
    !TASK_STATES.includes(status as TaskState)
  )
    a2aFail("invalidParams", "status must be a TaskState", {}, "status");
  let since: string | undefined;
  if (present(statusTimestampAfter)) {
    const time =
      typeof statusTimestampAfter === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(statusTimestampAfter)
        ? new Date(statusTimestampAfter)
        : undefined;
    if (!time || Number.isNaN(time.getTime()))
      a2aFail(
        "invalidParams",
        "statusTimestampAfter must be an ISO 8601 timestamp",
        {},
        "statusTimestampAfter"
      );
    since = time!.toISOString();
  }
  if (
    present(pageSize) &&
    (typeof pageSize !== "number" ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > LIST_PAGE_MAX)
  )
    a2aFail("invalidParams", `pageSize must be an integer from 1 to ${LIST_PAGE_MAX}`, {}, "pageSize");
  if (present(pageToken) && typeof pageToken !== "string")
    a2aFail("invalidParams", "pageToken must be a string", {}, "pageToken");
  if (includeArtifacts !== undefined && includeArtifacts !== null && typeof includeArtifacts !== "boolean")
    a2aFail("invalidParams", "includeArtifacts must be a boolean", {}, "includeArtifacts");
  const historyLength = parseHistoryLength(params.historyLength, "historyLength");
  return {
    ...(present(contextId) ? { contextId: contextId as string } : {}),
    ...(present(status) && status !== "TASK_STATE_UNSPECIFIED" ? { status: status as TaskState } : {}),
    ...(since !== undefined ? { statusTimestampAfter: since } : {}),
    pageSize: present(pageSize) ? (pageSize as number) : LIST_PAGE_DEFAULT,
    ...(present(pageToken) ? { pageToken: pageToken as string } : {}),
    ...(historyLength !== undefined ? { historyLength } : {}),
    includeArtifacts: includeArtifacts === true,
  };
}

/**
 * One turn's events, in stream order, read from its first lifecycle event: up to its last one
 * when it has ended, else to the stream's tail. Never the session's whole history.
 */
export async function indexedTurnEvents(ctx: TenantContext, row: TurnRow): Promise<LiveEvent[]> {
  const after = row.firstSeq > 0 ? encodeCursor(row.sessionId, row.firstSeq - 1) : undefined;
  const { items } = ENDED_TURN_STATUSES.has(row.status as TurnStatus)
    ? await readHistory(
        ctx,
        row.sessionId,
        after === undefined
          ? undefined
          : historyCursor(ctx.config.tenantId, row.sessionId).encode(after),
        undefined,
        row.lastSeq - row.firstSeq + 1
      )
    : await readHistory(ctx, row.sessionId, after, undefined);
  return items.filter((event) => event.turnId === row.turnId);
}

/** The events of a session's turn, from the turn index; none when the session never had it. */
export async function turnEventsOf(
  ctx: TenantContext,
  sessionId: string,
  turnId: string
): Promise<LiveEvent[]> {
  const row = await ctx.store.tx((t) => t.turn(sessionId, turnId));
  return row ? indexedTurnEvents(ctx, row) : [];
}

/** The caller of `ListTasks`: one subject, with one Agent. */
export interface ListCaller {
  readonly ctx: TenantContext;
  readonly access: SessionAccess;
  readonly agentId: string;
}

/** Builds one listed turn's task as `GetTask` does (`routes.ts`), or undefined when it has none. */
export type BuildListedTask = (
  row: TurnRow,
  session: Session,
  historyLength: number
) => Promise<Task | undefined>;

/** `ListTasks`: the caller's tasks with this Agent, from the turn index. */
export async function listTasks(
  caller: ListCaller,
  params: ListParams,
  build: BuildListedTask
): Promise<ListTasksResult> {
  const { ctx, access, agentId } = caller;
  const owner = access.owner;
  const token = readCursor(ctx.config.tenantId, "a2a-tasks", {
    owner,
    agentId,
    contextId: params.contextId ?? null,
    status: params.status ?? null,
    statusTimestampAfter: params.statusTimestampAfter ?? null,
  });
  let key: (string | null)[] | undefined;
  try {
    key = token.decode(params.pageToken);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return a2aFail("invalidParams", "pageToken is not one this request returned", {}, "pageToken");
  }
  if (key && (key.length !== 3 || key.some((part) => typeof part !== "string")))
    a2aFail("invalidParams", "pageToken is not one this request returned", {}, "pageToken");
  const states = params.status === undefined ? undefined : (TURN_STATES[params.status] ?? []);
  const { turns, total } = await ctx.store.tx((t) =>
    t.listTurns({
      ownerUserId: owner,
      agentId,
      a2a: true,
      ...(params.contextId === undefined
        ? {}
        : { sessionId: contextSessionId(owner, agentId, params.contextId) }),
      ...(states === undefined ? {} : { states }),
      ...(params.statusTimestampAfter === undefined ? {} : { changedSince: params.statusTimestampAfter }),
      ...(key ? { after: { changedAt: key[0]!, sessionId: key[1]!, turnId: key[2]! } } : {}),
      limit: params.pageSize + 1,
    })
  );
  const page = turns.slice(0, params.pageSize);
  const last = page.at(-1);
  const tasks: Task[] = [];
  const sessions = new Map<string, Session | undefined>();
  for (const row of page) {
    // Only a context the A2A server opened for this caller: its session id is the context's.
    if (contextSessionId(owner, agentId, row.a2aContextId!) !== row.sessionId) continue;
    if (!sessions.has(row.sessionId)) sessions.set(row.sessionId, await sessionOf(caller, row.sessionId));
    const session = sessions.get(row.sessionId);
    const built = session ? await build(row, session, params.historyLength ?? 0) : undefined;
    if (!built) continue;
    const { artifacts, ...task } = built;
    tasks.push({
      ...task,
      status: { ...task.status, timestamp: row.changedAt },
      ...(params.includeArtifacts && artifacts ? { artifacts } : {}),
    });
  }
  return {
    tasks,
    nextPageToken:
      turns.length > params.pageSize && last
        ? token.encode([last.changedAt, last.sessionId, last.turnId])
        : "",
    pageSize: params.pageSize,
    totalSize: total,
  };
}

/** The caller's session for a listed task, or undefined when it is gone. */
async function sessionOf(caller: ListCaller, sessionId: string): Promise<Session | undefined> {
  try {
    return await loadSession(caller.ctx, sessionId, caller.access);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}
