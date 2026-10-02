/**
 * Live delivery over Durable Streams (architecture §12.4, "Reading"): session history
 * (`GET /v1/sessions/:id/items`) and session SSE (`GET /v1/sessions/:id/events`).
 *
 * - **Streams.** A session's events are in `sessions/<id>` in the Tenant's current basin
 *   generation (`currentBasin`); cursors carry only the session id and sequence.
 * - **History** reads the session's stream from the cursor up to the tail seen when the read
 *   starts. The `agent` filter runs here, and the response cursor is the last record read. If
 *   the streams fail, history answers `503`.
 * - **SSE** shares one stream read per observed session in this process (a `SessionStream`)
 *   among that session's observers. Each observer keeps the next sequence it needs and skips
 *   what it already has, so a client resuming from `Last-Event-ID` sees no gap and no
 *   duplicate. An observer behind the feed restarts the shared read from its own position.
 *   A feed follows one basin generation: it ends once its session is gone or the Tenant moved
 *   to a new generation (a reset, possibly on another node), checked when a client joins, when
 *   its read fails, on a `sessions.reset` signal, and periodically (`checkSessionStreams`).
 *
 * Business code never writes here: events reach streams only through the stream relay, from
 * the record, after commit.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiveEvent } from "@nylorun/core/contracts";
import { decodeCursor, encodeCursor } from "../record/index.js";
import { basinOf } from "../streams/basin.js";
import {
  sessionStream,
  type DurableStreams,
  type StreamRecord,
} from "../streams/types.js";
import type { TenantContext } from "./context.js";
import { fail } from "./http.js";
import type { StreamsWiring } from "./streams.js";

/** Why the Runtime ended a stream a subject token opened. */
export type StreamEndReason = "token_expired" | "revoked";

/** Where an observer's events go: an SSE response, or an in-process reader. */
export interface ObserverSink {
  write(event: LiveEvent): void;
  /** Ends the stream; with a reason, the client is told why before it ends. */
  end(reason?: StreamEndReason): void;
}

/** The subject token a stream was opened with: it ends at expiry or revocation. */
export interface StreamHolder {
  readonly subject: string;
  readonly epoch: number;
  /** Epoch ms when the token expires. */
  readonly expiresAt: number;
}

/** One client of a session: the next sequence it needs. */
interface Observer {
  readonly sink: ObserverSink;
  next: number;
  readonly holder?: StreamHolder;
  /** Ends the observer when its token expires. */
  deadline?: NodeJS.Timeout;
}

/** The shared stream read of one observed session. */
interface SessionStream {
  readonly sessionId: string;
  /** The basin the feed reads (the Tenant's generation when it started). */
  readonly basin: string;
  readonly stream: string;
  /** The sequence the shared read yields next. Every observer's `next` is at or past it. */
  next: number;
  readonly observers: Set<Observer>;
  /** Aborts the current read; replaced when the read restarts from an earlier sequence. */
  read: AbortController;
}

export interface SessionStreams {
  /** Set once by `wireStreams`. */
  wiring: StreamsWiring | undefined;
  /** The Tenant's basin generation as this process last saw it (`wireStreams` keeps it). */
  generation: number;
  /** Session id → its shared read and observers. */
  readonly sessions: Map<string, SessionStream>;
}

export function createSessionStreams(): SessionStreams {
  return { wiring: undefined, generation: 0, sessions: new Map() };
}
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

/** The frame that tells a client why the Runtime ended its stream (no `id:`: not an event). */
function closedFrame(reason: StreamEndReason): string {
  return `event: nylorun.closed\ndata: ${JSON.stringify({ reason })}\n\n`;
}

/** An observer sink writing SSE frames to `response`. */
function sseSink(response: ServerResponse): ObserverSink {
  return {
    write: (event) => send(response, frame(event)),
    end: (reason) => {
      if (reason && !response.writableEnded) send(response, closedFrame(reason));
      response.end();
    },
  };
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

/** The basin the Tenant's session streams are in now. */
export function currentBasin(ctx: TenantContext): string {
  return basinOf(ctx.config.tenantId, ctx.sessionStreams.generation);
}

interface StreamRef {
  basin: string;
  stream: string;
}

/** The session's stream now, or undefined when the session is gone. */
async function currentStream(
  ctx: TenantContext,
  sessionId: string
): Promise<StreamRef | undefined> {
  const session = await ctx.store.tx((t) => t.get("sessions", sessionId));
  return session && { basin: currentBasin(ctx), stream: sessionStream(sessionId) };
}

const sameStream = (feed: StreamRef, ref: StreamRef | undefined) =>
  ref !== undefined && ref.basin === feed.basin && ref.stream === feed.stream;

function streamsOf(ctx: TenantContext): DurableStreams {
  return (
    ctx.sessionStreams.wiring?.streams ?? fail(503, "Session streams are unavailable")
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
  const ref =
    (await currentStream(ctx, sessionId)) ?? fail(404, "Session not found");
  const items: LiveEvent[] = [];
  let last: number | undefined;
  try {
    for await (const record of streams.read<LiveEvent>(
      ref.basin,
      ref.stream,
      from,
      { follow: false }
    )) {
      last = record.seq;
      if (served(record.body) && (agent === undefined || belongsTo(record.body, agent)))
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
  cursor: string | undefined,
  holder?: StreamHolder
): Promise<void> {
  const observer: Observer = {
    sink: sseSink(response),
    next: startSeq(sessionId, cursor),
    ...(holder ? { holder } : {}),
  };
  const joined = await join(ctx, sessionId, observer);
  openSse(request, response, () => leave(ctx.sessionStreams, joined, observer));
  armDeadline(ctx.sessionStreams, joined, observer);
}

/** Thrown by `observeSession` when the Runtime ended the stream for its token. */
export class StreamClosed extends Error {
  constructor(
    readonly reason: StreamEndReason,
    /** The cursor of the last event delivered, if any. */
    readonly cursor: string | undefined
  ) {
    super(`The stream ended: ${reason}`);
    this.name = "StreamClosed";
  }
}

/**
 * A session's events from `cursor`, in process: the same shared read and deadlines as an SSE
 * client (`streamSessionEvents`). Ends when `signal` aborts or the feed ends; throws
 * `StreamClosed` when the Runtime ends it for its token (expiry or revocation).
 */
export async function* observeSession(
  ctx: TenantContext,
  sessionId: string,
  cursor: string | undefined,
  options: { holder?: StreamHolder; signal: AbortSignal }
): AsyncGenerator<LiveEvent> {
  const queue: LiveEvent[] = [];
  let ended: { reason?: StreamEndReason } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const observer: Observer = {
    sink: {
      write: (event) => {
        queue.push(event);
        notify();
      },
      end: (reason) => {
        ended = reason ? { reason } : {};
        notify();
      },
    },
    next: startSeq(sessionId, cursor),
    ...(options.holder ? { holder: options.holder } : {}),
  };
  const joined = await join(ctx, sessionId, observer);
  armDeadline(ctx.sessionStreams, joined, observer);
  const stop = () => {
    leave(ctx.sessionStreams, joined, observer);
    notify();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  let last = cursor;
  try {
    for (;;) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        last = event.cursor;
        yield event;
      }
      if (options.signal.aborted) return;
      if (ended) {
        if (ended.reason) throw new StreamClosed(ended.reason, last);
        return;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    options.signal.removeEventListener("abort", stop);
    leave(ctx.sessionStreams, joined, observer);
  }
}

/** Ends the observer when its token expires. */
function armDeadline(hub: SessionStreams, feed: SessionStream, observer: Observer): void {
  if (!observer.holder) return;
  observer.deadline = setTimeout(
    () => endObserver(hub, feed, observer, "token_expired"),
    Math.max(0, observer.holder.expiresAt - Date.now())
  );
  observer.deadline.unref();
}

/**
 * Adds `observer` to the session's shared read, starting or restarting it from the
 * observer's position when needed. 404 when the session has no stream.
 */
async function join(
  ctx: TenantContext,
  sessionId: string,
  observer: Observer
): Promise<SessionStream> {
  const from = observer.next;
  streamsOf(ctx);
  const ref =
    (await currentStream(ctx, sessionId)) ?? fail(404, "Session not found");
  const hub = ctx.sessionStreams;
  let feed = hub.sessions.get(sessionId);
  if (feed && !sameStream(feed, ref)) {
    // The Tenant moved to a new basin since that feed started: it follows an abandoned stream.
    endFeed(hub, feed);
    feed = undefined;
  }
  if (!feed) {
    feed = {
      sessionId,
      basin: ref.basin,
      stream: ref.stream,
      next: from,
      observers: new Set(),
      read: new AbortController(),
    };
    hub.sessions.set(sessionId, feed);
    runFeed(ctx, feed);
  } else if (from < feed.next) {
    // Behind the shared read: restart it here; observers ahead skip what they have.
    feed.read.abort();
    feed.read = new AbortController();
    feed.next = from;
    runFeed(ctx, feed);
  }
  feed.observers.add(observer);
  return feed;
}

/** Ends one observer early (its token expired or was revoked). */
function endObserver(
  hub: SessionStreams,
  feed: SessionStream,
  observer: Observer,
  reason: StreamEndReason
): void {
  if (!feed.observers.has(observer)) return;
  leave(hub, feed, observer);
  observer.sink.end(reason);
}

function leave(hub: SessionStreams, feed: SessionStream, observer: Observer): void {
  if (observer.deadline) clearTimeout(observer.deadline);
  if (!feed.observers.delete(observer)) return;
  if (feed.observers.size > 0) return;
  feed.read.abort();
  if (hub.sessions.get(feed.sessionId) === feed) hub.sessions.delete(feed.sessionId);
}

function deliver(observer: Observer, record: StreamRecord<LiveEvent>): void {
  if (record.seq < observer.next) return;
  observer.next = record.seq + 1;
  if (served(record.body)) observer.sink.write(record.body);
}

/** Internal events (`transcript.updated`) are recorded and streamed but never served. */
export function served(event: LiveEvent): boolean {
  return event.visibility !== "internal";
}

/**
 * Follows the feed's stream from `feed.next` for the current `feed.read`, retrying failed
 * reads from where it stopped while the session still has that stream. A read that ends by
 * itself (the stream's Tenant is gone or the streams closed), or a session that is gone or
 * whose Tenant moved to a new basin, ends the observers.
 */
function runFeed(ctx: TenantContext, feed: SessionStream): void {
  const read = feed.read;
  const signal = read.signal;
  void (async () => {
    let delay = RETRY_MIN_MS;
    while (!signal.aborted) {
      const streams = ctx.sessionStreams.wiring?.streams;
      if (!streams) break;
      try {
        for await (const record of streams.read<LiveEvent>(
          feed.basin,
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
    endFeed(ctx.sessionStreams, feed);
  })();
}

/** False when the feed's session is gone or the Tenant moved to a new basin. True when unsure. */
async function stillCurrent(ctx: TenantContext, feed: SessionStream): Promise<boolean> {
  try {
    return sameStream(feed, await currentStream(ctx, feed.sessionId));
  } catch {
    return true;
  }
}

/**
 * Ends every feed in this process whose session is gone or whose Tenant moved to a new basin
 * generation, and moves this process to the Tenant's current generation. Run on a
 * `sessions.reset` signal and periodically, so feeds on nodes other than the one that reset
 * the Tenant end too.
 */
export async function checkSessionStreams(ctx: TenantContext): Promise<void> {
  const feeds = [...ctx.sessionStreams.sessions.values()];
  // Also a backstop for lost `subject.revoked` signals: the holders' current epochs.
  const subjects = new Set<string>();
  for (const feed of feeds)
    for (const observer of feed.observers)
      if (observer.holder) subjects.add(observer.holder.subject);
  const { exists, epochs, generation } = await ctx.store.tx(async (t) => {
    const exists = new Set<string>();
    for (const feed of feeds)
      if (await t.get("sessions", feed.sessionId)) exists.add(feed.sessionId);
    return {
      exists,
      generation: (await t.basinGenerations()).current,
      epochs:
        subjects.size === 0
          ? new Map<string, number>()
          : await t.subjectEpochs([...subjects]),
    };
  });
  if (generation !== ctx.sessionStreams.generation)
    ctx.sessionStreams.wiring?.moveTo(generation);
  for (const feed of feeds)
    if (
      ctx.sessionStreams.sessions.get(feed.sessionId) === feed &&
      !sameStream(
        feed,
        exists.has(feed.sessionId)
          ? { basin: currentBasin(ctx), stream: sessionStream(feed.sessionId) }
          : undefined
      )
    )
      endFeed(ctx.sessionStreams, feed);
  for (const [subject, epoch] of epochs)
    endSubjectStreams(ctx.sessionStreams, subject, epoch);
}

/**
 * Ends the streams of `subject` opened with a token older than `epoch` (a revocation), on
 * this process. Other processes do the same on the `subject.revoked` signal.
 */
export function endSubjectStreams(
  hub: SessionStreams,
  subject: string,
  epoch: number
): void {
  for (const feed of [...hub.sessions.values()])
    for (const observer of [...feed.observers])
      if (observer.holder?.subject === subject && observer.holder.epoch < epoch)
        endObserver(hub, feed, observer, "revoked");
}

function endFeed(hub: SessionStreams, feed: SessionStream): void {
  feed.read.abort();
  if (hub.sessions.get(feed.sessionId) === feed) hub.sessions.delete(feed.sessionId);
  for (const observer of feed.observers) {
    if (observer.deadline) clearTimeout(observer.deadline);
    observer.sink.end();
  }
  feed.observers.clear();
}

/** Reset or close: end every session observer and stop every shared read. */
export function clearObservers(hub: SessionStreams): void {
  for (const feed of [...hub.sessions.values()]) endFeed(hub, feed);
  hub.sessions.clear();
}

/** Close: end every session observer. */
export function endAllStreams(hub: SessionStreams): void {
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
