/**
 * Live delivery over Durable Streams (architecture §12.4, "Reading"): session history
 * (`GET /v1/sessions/:id/items`), session SSE (`GET /v1/sessions/:id/events`) and executor
 * work streams (`GET /v1/executors/connect`).
 *
 * - **Streams.** A session's events are in the stream of its current incarnation
 *   (`streamOfSession`, `sessions/<id>/<incarnation>`), resolved from the session on every
 *   request; cursors carry only the session id and sequence.
 * - **History** reads the session's stream from the cursor up to the tail seen when the read
 *   starts. The `agent` filter runs here, and the response cursor is the last record read. If
 *   the streams fail, history answers `503`.
 * - **SSE** shares one stream read per observed session in this process (a `SessionFeed`)
 *   among that session's observers. Each observer keeps the next sequence it needs and skips
 *   what it already has, so a client resuming from `Last-Event-ID` sees no gap and no
 *   duplicate. An observer behind the feed restarts the shared read from its own position.
 *   A feed follows one incarnation: it ends once its session is gone or has a new
 *   incarnation (a reset, possibly on another node), checked when a client joins, when its
 *   read fails, on a `sessions.reset` signal, and periodically (`checkFeeds`).
 * - **Executor streams** receive `work_available` from the `tenant/work` reader that
 *   `tenant/streams.ts` runs (one per Tenant per process); discovery stays `GET /v1/actions`.
 *
 * Business code never writes here: events reach streams only through the relay, after commit.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiveEvent } from "@nylorun/core/contracts";
import { decodeCursor, encodeCursor } from "../store/cursor.js";
import {
  streamOfSession,
  type DurableStreams,
  type SessionStreamRef,
  type StreamRecord,
} from "../streams/types.js";
import type { TenantContext } from "./context.js";
import { fail } from "./http.js";
import type { StreamsWiring } from "./streams.js";

/** One SSE client of a session: the next sequence it needs. */
interface Observer {
  readonly response: ServerResponse;
  next: number;
}

/** The shared stream read of one observed session. */
interface SessionFeed {
  readonly sessionId: string;
  /** The stream of the session's incarnation when the feed started. */
  readonly stream: string;
  /** The sequence the shared read yields next. Every observer's `next` is at or past it. */
  next: number;
  readonly observers: Set<Observer>;
  /** Aborts the current read; replaced when the read restarts from an earlier sequence. */
  read: AbortController;
}

export interface LiveHub {
  /** Set once by `wireStreams`. */
  wiring: StreamsWiring | undefined;
  /** Session id → its shared read and observers. */
  readonly feeds: Map<string, SessionFeed>;
  // Keyed by token hash so a rotation can end exactly the streams that the replaced token owns.
  readonly executorStreams: Map<string, Set<ServerResponse>>;
}

export function createLiveHub(): LiveHub {
  return { wiring: undefined, feeds: new Map(), executorStreams: new Map() };
}

const WORK_AVAILABLE =
  'event: work_available\ndata: {"type":"work_available"}\n\n';
const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 2000;

function frame(event: LiveEvent): string {
  return `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(
    event
  )}\n\n`;
}

export function send(response: ServerResponse, data: string): void {
  if (!response.write(data)) response.destroy();
}

/** Start an SSE response with keepalives; `onClose` runs once the client goes away. */
export function openSse(
  request: IncomingMessage,
  response: ServerResponse,
  onClose: () => void
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const timer = setInterval(() => send(response, ": keepalive\n\n"), 15000);
  timer.unref();
  request.on("close", () => {
    clearInterval(timer);
    onClose();
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

/** The first sequence to read: after the cursor's, or the session's first event. */
function startSeq(sessionId: string, cursor: string | undefined): number {
  return cursor ? decodeCursor(sessionId, cursor) + 1 : 0;
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

/** The stream of the session's current incarnation, or undefined when the session is gone. */
async function currentStream(
  ctx: TenantContext,
  sessionId: string
): Promise<string | undefined> {
  const session = await ctx.store.tx((t) =>
    t.get<SessionStreamRef>("sessions", sessionId)
  );
  return session && streamOfSession(session);
}

function streamsOf(ctx: TenantContext): DurableStreams {
  return (
    ctx.live.wiring?.streams ?? fail(503, "Session streams are unavailable")
  );
}

/**
 * `GET /v1/sessions/:id/items`: the session stream after the cursor, up to its tail when the
 * read starts. The cursor returned is the last record read (the request's cursor when none
 * was), whatever the `agent` filter kept.
 */
export async function readHistory(
  ctx: TenantContext,
  sessionId: string,
  cursor: string | undefined,
  agent: string | undefined
): Promise<{ items: LiveEvent[]; cursor: string | null }> {
  const from = startSeq(sessionId, cursor);
  const streams = streamsOf(ctx);
  const stream =
    (await currentStream(ctx, sessionId)) ?? fail(404, "Session not found");
  const items: LiveEvent[] = [];
  let last: number | undefined;
  try {
    for await (const record of streams.read<LiveEvent>(
      ctx.config.tenantId,
      stream,
      from,
      { follow: false }
    )) {
      last = record.seq;
      if (agent === undefined || belongsTo(record.body, agent))
        items.push(record.body);
    }
  } catch (error) {
    ctx.config.logger.warn("session history read failed", {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    fail(503, "Session history is unavailable");
  }
  return {
    items,
    cursor:
      last !== undefined ? encodeCursor(sessionId, last) : cursor ?? null,
  };
}

/**
 * `GET /v1/sessions/:id/events`: joins the session's shared read at the client's cursor and
 * follows it until the client leaves, the session is reset or deleted, or the Tenant closes.
 */
export async function streamSessionEvents(
  ctx: TenantContext,
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  cursor: string | undefined
): Promise<void> {
  const from = startSeq(sessionId, cursor);
  streamsOf(ctx);
  const stream =
    (await currentStream(ctx, sessionId)) ?? fail(404, "Session not found");
  const hub = ctx.live;
  const observer: Observer = { response, next: from };
  let feed = hub.feeds.get(sessionId);
  if (feed && feed.stream !== stream) {
    // The session was created again since that feed started: it follows an abandoned stream.
    endFeed(hub, feed);
    feed = undefined;
  }
  if (!feed) {
    feed = {
      sessionId,
      stream,
      next: from,
      observers: new Set(),
      read: new AbortController(),
    };
    hub.feeds.set(sessionId, feed);
    runFeed(ctx, feed);
  } else if (from < feed.next) {
    // Behind the shared read: restart it here; observers ahead skip what they have.
    feed.read.abort();
    feed.read = new AbortController();
    feed.next = from;
    runFeed(ctx, feed);
  }
  const joined = feed;
  joined.observers.add(observer);
  openSse(request, response, () => leave(hub, joined, observer));
}

function leave(hub: LiveHub, feed: SessionFeed, observer: Observer): void {
  feed.observers.delete(observer);
  if (feed.observers.size > 0) return;
  feed.read.abort();
  if (hub.feeds.get(feed.sessionId) === feed) hub.feeds.delete(feed.sessionId);
}

function deliver(observer: Observer, record: StreamRecord<LiveEvent>): void {
  if (record.seq < observer.next) return;
  observer.next = record.seq + 1;
  send(observer.response, frame(record.body));
}

/**
 * Follows the feed's stream from `feed.next` for the current `feed.read`, retrying failed
 * reads from where it stopped while the session still has that stream. A read that ends by
 * itself (the stream's Tenant is gone or the streams closed), or a session that is gone or
 * has a new incarnation, ends the observers.
 */
function runFeed(ctx: TenantContext, feed: SessionFeed): void {
  const read = feed.read;
  const signal = read.signal;
  void (async () => {
    let delay = RETRY_MIN_MS;
    while (!signal.aborted) {
      const streams = ctx.live.wiring?.streams;
      if (!streams) break;
      try {
        for await (const record of streams.read<LiveEvent>(
          ctx.config.tenantId,
          feed.stream,
          feed.next,
          { signal }
        )) {
          // A restart replaced this read: the new one owns `feed.next`.
          if (signal.aborted || feed.read !== read) return;
          if (record.seq < feed.next) continue;
          feed.next = record.seq + 1;
          delay = RETRY_MIN_MS;
          for (const observer of feed.observers) deliver(observer, record);
        }
        if (signal.aborted) return;
        break;
      } catch (error) {
        if (signal.aborted) return;
        ctx.config.logger.warn("session stream read failed; retrying", {
          sessionId: feed.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (!(await stillCurrent(ctx, feed))) break;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
    if (signal.aborted || feed.read !== read) return;
    endFeed(ctx.live, feed);
  })();
}

/** False when the feed's session is gone or has a new incarnation. True when unsure. */
async function stillCurrent(ctx: TenantContext, feed: SessionFeed): Promise<boolean> {
  try {
    return (await currentStream(ctx, feed.sessionId)) === feed.stream;
  } catch {
    return true;
  }
}

/**
 * Ends every feed in this process whose session is gone or has a new incarnation. Run on a
 * `sessions.reset` signal and periodically, so feeds on nodes other than the one that reset
 * the Tenant end too.
 */
export async function checkFeeds(ctx: TenantContext): Promise<void> {
  const feeds = [...ctx.live.feeds.values()];
  if (feeds.length === 0) return;
  const current = await ctx.store.tx(async (t) => {
    const streams = new Map<string, string | undefined>();
    for (const feed of feeds) {
      const session = await t.get<SessionStreamRef>("sessions", feed.sessionId);
      streams.set(feed.sessionId, session && streamOfSession(session));
    }
    return streams;
  });
  for (const feed of feeds)
    if (
      ctx.live.feeds.get(feed.sessionId) === feed &&
      current.get(feed.sessionId) !== feed.stream
    )
      endFeed(ctx.live, feed);
}

function endFeed(hub: LiveHub, feed: SessionFeed): void {
  feed.read.abort();
  if (hub.feeds.get(feed.sessionId) === feed) hub.feeds.delete(feed.sessionId);
  for (const observer of feed.observers) observer.response.end();
  feed.observers.clear();
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
  const set = streams;
  set.add(response);
  openSse(request, response, () => {
    set.delete(response);
    if (!set.size && hub.executorStreams.get(tokenHash) === set)
      hub.executorStreams.delete(tokenHash);
  });
  send(response, WORK_AVAILABLE);
}

/** Called by the `tenant/work` reader for each signal: wake every connected executor. */
export function announceWork(hub: LiveHub): void {
  for (const streams of hub.executorStreams.values())
    for (const response of streams) send(response, WORK_AVAILABLE);
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

/** Reset or close: end every session observer and stop every shared read. */
export function clearObservers(hub: LiveHub): void {
  for (const feed of [...hub.feeds.values()]) endFeed(hub, feed);
  hub.feeds.clear();
}

/** Reset: end and forget every executor stream. */
export function clearExecutorStreams(hub: LiveHub): void {
  for (const streams of hub.executorStreams.values())
    for (const r of streams) r.end();
  hub.executorStreams.clear();
}

/** Close: end every executor stream, then every session observer. */
export function endAllStreams(hub: LiveHub): void {
  clearExecutorStreams(hub);
  clearObservers(hub);
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
