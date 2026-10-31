/**
 * A2A tasks read from the turn index (Host feature `turns`): `ListTasks` (A2A 1.0 §3.1.4) and
 * the bounded reads of one turn's events that `GetTask`, `CancelTask` and replies use. A context
 * is listable because `openContext` writes `info.a2a` on its session, which the index copies into
 * each turn's row; nothing here scans a session's whole history.
 *
 * `ListTasks` is scoped before any lookup: the caller's own subject and this endpoint's Agent,
 * A2A contexts only. Tasks come latest status change first; a page's token is the last task's
 * position, bound to the caller and the filters. A task's `status.timestamp` is when its status
 * last changed (`statusTimestampAfter` compares with it). Without `historyLength` or
 * `includeArtifacts` a task is built from its index row alone (and, while it waits for input,
 * its session's question); with them, from its own events.
 */
import type { LiveEvent, TurnStatus } from "@nylorun/core/contracts";
import { encodeCursor } from "../../record/index.js";
import { historyCursor, readCursor } from "../../reads/cursor.js";
import type { TurnRow } from "../../store/types.js";
import { ENDED_TURN_STATUSES } from "../../store/postgres/turns.js";
import { loadSession, type Session, type SessionAccess, type TenantContext } from "../../tenant/context.js";
import { HttpError } from "../../tenant/http.js";
import { readHistory } from "../../tenant/session-streams.js";
import {
  a2aFail,
  parseHistoryLength,
  type Message,
  type Task,
  type TaskState,
} from "./protocol.js";
import { buildTask, contextSessionId, pendingInteraction, taskIdOf } from "./tasks.js";

/** `ListTasks`' page size when the request names none, and the most it may ask. */
export const LIST_PAGE_DEFAULT = 50;
export const LIST_PAGE_MAX = 100;

/** The A2A state of each turn status. */
const STATE_OF: Readonly<Record<TurnStatus, TaskState>> = {
  running: "TASK_STATE_WORKING",
  paused: "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  cancelled: "TASK_STATE_CANCELED",
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

/** `ListTasks`: the caller's tasks with this Agent, from the turn index. */
export async function listTasks(caller: ListCaller, params: ListParams): Promise<ListTasksResult> {
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
  const statuses =
    params.status === undefined
      ? undefined
      : (Object.keys(STATE_OF) as TurnStatus[]).filter((status) => STATE_OF[status] === params.status);
  const { turns, total } = await ctx.store.tx((t) =>
    t.listTurns({
      ownerUserId: owner,
      agentId,
      a2a: true,
      ...(params.contextId === undefined
        ? {}
        : { sessionId: contextSessionId(owner, agentId, params.contextId) }),
      ...(statuses === undefined ? {} : { statuses }),
      ...(params.statusTimestampAfter === undefined ? {} : { changedSince: params.statusTimestampAfter }),
      ...(key ? { after: { changedAt: key[0]!, sessionId: key[1]!, turnId: key[2]! } } : {}),
      limit: params.pageSize + 1,
    })
  );
  const page = turns.slice(0, params.pageSize);
  const last = page.at(-1);
  const tasks: Task[] = [];
  for (const row of page) {
    // Only a context the A2A server opened for this caller: its session id is the context's.
    if (contextSessionId(owner, agentId, row.a2aContextId!) !== row.sessionId) continue;
    tasks.push(await indexedTask(caller, row, params));
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

/** One listed task: from its row, or from its events when history or artifacts are asked for. */
async function indexedTask(caller: ListCaller, row: TurnRow, params: ListParams): Promise<Task> {
  const contextId = row.a2aContextId!;
  const taskId = taskIdOf(contextId, row.turnId);
  const state = STATE_OF[row.status as TurnStatus];
  const status = { state, timestamp: row.changedAt };
  if ((params.historyLength ?? 0) > 0 || params.includeArtifacts) {
    const session = await sessionOf(caller, row.sessionId);
    const built = session
      ? buildTask({
          contextId,
          turnId: row.turnId,
          session,
          events: await indexedTurnEvents(caller.ctx, row),
          historyLength: params.historyLength ?? 0,
        })
      : undefined;
    if (built) {
      const { artifacts, ...task } = built;
      return {
        ...task,
        status: { ...built.status, timestamp: row.changedAt },
        ...(params.includeArtifacts && artifacts ? { artifacts } : {}),
      };
    }
  }
  let message: Message | undefined;
  if (row.status === "paused") {
    // The question it waits on is on its session, not in its history.
    const session = await sessionOf(caller, row.sessionId);
    const pending = session && session.activeTurnId === row.turnId ? pendingInteraction(session) : undefined;
    if (pending)
      message = { messageId: pending.id, role: "ROLE_AGENT", parts: [{ text: pending.prompt }], contextId, taskId };
  } else if (row.status === "failed")
    message = {
      messageId: `${row.turnId}:failed`,
      role: "ROLE_AGENT",
      parts: [{ text: "The agent failed." }],
      contextId,
      taskId,
    };
  return { id: taskId, contextId, status: { ...status, ...(message ? { message } : {}) } };
}
