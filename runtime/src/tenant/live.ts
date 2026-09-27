/**
 * Live delivery in process: session observers (SSE on `/v1/sessions/:id/events`), executor
 * streams (`/v1/executors/connect`), `publish` and `notify`, and the history reads.
 *
 * Business code never calls `publish` or `notify` here directly; it goes through
 * `ctx.publish` / `ctx.notify`, which `runtime.ts` wires to these functions.
 *
 * Later waves: Wave 2 / Y replaces `observers`/`publish` with history and SSE readers over
 * Durable Streams, and `executorStreams`/`notify` with the `tenant/work` stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { TenantContext } from "./context.js";

export interface LiveHub {
  /** Session id → open SSE responses. */
  readonly observers: Map<string, Set<ServerResponse>>;
  // Keyed by token hash so a rotation can end exactly the streams that the replaced token owns.
  readonly executorStreams: Map<string, Set<ServerResponse>>;
}

export function createLiveHub(): LiveHub {
  return { observers: new Map(), executorStreams: new Map() };
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
  for (const response of hub.observers.get(event.sessionId) ?? [])
    send(response, frame(event));
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

/** `GET /v1/sessions/:id/items`. */
export function readHistory(
  ctx: TenantContext,
  sessionId: string,
  cursor: string | undefined,
  agent: string | undefined
) {
  return ctx.store.history(sessionId, cursor, agent);
}

/** `GET /v1/sessions/:id/events`: replay history after the cursor, then follow live. */
export function streamSessionEvents(
  ctx: TenantContext,
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  cursor: string | undefined
): void {
  const history = ctx.store.history(sessionId, cursor);
  const set = ctx.live.observers.get(sessionId) ?? new Set<ServerResponse>();
  ctx.live.observers.set(sessionId, set);
  openSse(request, response, set);
  for (const event of history.items) send(response, frame(event));
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
