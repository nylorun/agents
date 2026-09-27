/**
 * Live delivery in process: session observers (SSE on `/v1/sessions/:id/events`), executor
 * streams (`/v1/executors/connect`), `publish` and `notify`, and the history reads.
 *
 * Business code never calls `publish` or `notify`: `runtime.ts` subscribes them to the Session
 * Store's commit listener, so an event reaches observers only after its transaction commits.
 *
 * Later waves: Wave 2 / Y replaces `observers`/`publish` with history and SSE readers over
 * Durable Streams, and `executorStreams`/`notify` with the `tenant/work` stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiveEvent } from "@nylorun/core/contracts";
import { decodeCursor, encodeCursor } from "../store/cursor.js";
import type { TenantContext } from "./context.js";

export interface LiveHub {
  /** Session id → open SSE responses. */
  readonly observers: Map<string, Set<ServerResponse>>;
  // Keyed by token hash so a rotation can end exactly the streams that the replaced token owns.
  readonly executorStreams: Map<string, Set<ServerResponse>>;
  /** Observers still replaying history: live events wait here until the replay is written. */
  readonly replaying: WeakMap<ServerResponse, LiveEvent[]>;
}

export function createLiveHub(): LiveHub {
  return {
    observers: new Map(),
    executorStreams: new Map(),
    replaying: new WeakMap(),
  };
}

const WORK_AVAILABLE =
  'event: work_available\ndata: {"type":"work_available"}\n\n';

function frame(event: LiveEvent): string {
  return `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(
    event
  )}\n\n`;
}

export function send(response: ServerResponse, data: string): void {
  if (!response.write(data)) response.destroy();
}

export function publish(hub: LiveHub, event: LiveEvent): void {
  for (const response of hub.observers.get(event.sessionId) ?? []) {
    const buffer = hub.replaying.get(response);
    if (buffer) buffer.push(event);
    else send(response, frame(event));
  }
}

export function notify(hub: LiveHub): void {
  for (const streams of hub.executorStreams.values())
    for (const response of streams) send(response, WORK_AVAILABLE);
}

/** Start an SSE response and keep it in `set` until the client goes away. */
export function openSse(
  request: IncomingMessage,
  response: ServerResponse,
  set: Set<ServerResponse>,
  whenEmpty?: () => void
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  set.add(response);
  const timer = setInterval(() => send(response, ": keepalive\n\n"), 15000);
  timer.unref();
  request.on("close", () => {
    clearInterval(timer);
    set.delete(response);
    if (!set.size) whenEmpty?.();
  });
}

/** The resume cursor: `?cursor=` wins over `Last-Event-ID`. */
export function requestCursor(
  request: IncomingMessage,
  url: URL
): string | undefined {
  return (
    url.searchParams.get("cursor") ??
    (typeof request.headers["last-event-id"] === "string"
      ? request.headers["last-event-id"]
      : undefined)
  );
}

/** The sequence after which to read: the cursor's, or before the first event. */
function afterSeq(sessionId: string, cursor: string | undefined): number {
  return cursor ? decodeCursor(sessionId, cursor) : -1;
}

/** `agent` keeps only events of one agent used as a tool, by delegationId or path. */
function belongsTo(event: LiveEvent, agent: string): boolean {
  const ref = (
    event.payload as {
      agent?: { path?: unknown; delegationId?: unknown };
    } | null
  )?.agent;
  return ref?.delegationId === agent || ref?.path === agent;
}

/** `GET /v1/sessions/:id/items`. */
export async function readHistory(
  ctx: TenantContext,
  sessionId: string,
  cursor: string | undefined,
  agent: string | undefined
): Promise<{ items: LiveEvent[]; cursor: string | null }> {
  const { events, lastSeq } = await ctx.history.readEvents(
    sessionId,
    afterSeq(sessionId, cursor)
  );
  return {
    items:
      agent === undefined
        ? events
        : events.filter((event) => belongsTo(event, agent)),
    cursor: lastSeq === null ? null : encodeCursor(sessionId, lastSeq),
  };
}

/**
 * `GET /v1/sessions/:id/events`: replay history after the cursor, then follow live. The
 * observer is registered before the history read and buffers live events until the replay
 * is written, so an event committed in between is neither lost nor sent twice.
 */
export async function streamSessionEvents(
  ctx: TenantContext,
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  cursor: string | undefined
): Promise<void> {
  let last = afterSeq(sessionId, cursor);
  const buffered: LiveEvent[] = [];
  ctx.live.replaying.set(response, buffered);
  const set = ctx.live.observers.get(sessionId) ?? new Set<ServerResponse>();
  ctx.live.observers.set(sessionId, set);
  openSse(request, response, set);
  try {
    const history = await ctx.history.readEvents(sessionId, last);
    for (const event of [...history.events, ...buffered]) {
      const seq = decodeCursor(sessionId, event.cursor);
      if (seq <= last) continue;
      last = seq;
      send(response, frame(event));
    }
  } catch {
    response.end();
  } finally {
    ctx.live.replaying.delete(response);
  }
}

/** `GET /v1/executors/connect`: an executor's work stream, primed with one `work_available`. */
export function streamExecutorWork(
  hub: LiveHub,
  request: IncomingMessage,
  response: ServerResponse,
  tokenHash: string
): void {
  let streams = hub.executorStreams.get(tokenHash);
  if (!streams) hub.executorStreams.set(tokenHash, (streams = new Set()));
  openSse(request, response, streams, () =>
    hub.executorStreams.delete(tokenHash)
  );
  send(response, WORK_AVAILABLE);
}

export function executorConnected(hub: LiveHub, tokenHash: string): boolean {
  return (hub.executorStreams.get(tokenHash)?.size ?? 0) > 0;
}

export function connectedExecutorCount(hub: LiveHub): number {
  return [...hub.executorStreams.values()].filter((set) => set.size > 0)
    .length;
}

/** End the streams a token owns (rotation or deregistration). */
export function endExecutorStreams(hub: LiveHub, tokenHash: string): void {
  for (const r of hub.executorStreams.get(tokenHash) ?? []) r.end();
  hub.executorStreams.delete(tokenHash);
}

/** Reset: end and forget every session observer. */
export function clearObservers(hub: LiveHub): void {
  for (const set of hub.observers.values()) for (const r of set) r.end();
  hub.observers.clear();
}

/** Reset: end and forget every executor stream. */
export function clearExecutorStreams(hub: LiveHub): void {
  for (const streams of hub.executorStreams.values())
    for (const r of streams) r.end();
  hub.executorStreams.clear();
}

/** Close: end every executor stream, then every session observer. */
export function endAllStreams(hub: LiveHub): void {
  for (const streams of hub.executorStreams.values())
    for (const r of streams) r.end();
  for (const set of hub.observers.values()) for (const r of set) r.end();
}
