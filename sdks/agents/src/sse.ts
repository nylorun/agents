import { delay, RuntimeError, type Transport } from "./http.js";
export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}
/**
 * How long a stream may send nothing before the client takes it for dead: the Runtime sends a
 * `: keepalive` comment every 15 s, so three missed ones.
 */
export const SSE_IDLE_TIMEOUT_MS = 45_000;
/** A stream sent no byte, not even a keepalive, for `idleTimeoutMs`. */
export class SSEIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`The event stream sent nothing for ${idleTimeoutMs} ms`);
    this.name = "SSEIdleTimeoutError";
  }
}
/**
 * How many connections in a row `observeSSE` lets end with no event and no keepalive before it
 * gives up with `SSEStreamClosedError`.
 */
export const SSE_MAX_EMPTY_CONNECTIONS = 5;
/**
 * The stream kept closing with nothing on it: `connections` connections in a row ended without
 * an event or a keepalive, so reconnecting from `cursor` again would only repeat it.
 */
export class SSEStreamClosedError extends Error {
  constructor(
    readonly connections: number,
    /** The cursor each connection resumed from; undefined for the stream's start. */
    readonly cursor: string | undefined
  ) {
    super(
      `The event stream closed ${connections} times in a row with no event, from ${
        cursor === undefined ? "its start" : `cursor ${cursor}`
      }`
    );
    this.name = "SSEStreamClosedError";
  }
}
/**
 * Fetch-based SSE supports Authorization headers and works in browsers and Node. Any byte,
 * keepalive comments included, counts as liveness; after `idleTimeoutMs` without one the read
 * stops with `SSEIdleTimeoutError` (`0` waits forever). `onComment` runs for each comment line
 * (the Runtime's `: keepalive`).
 */
export async function* readSSE(
  response: Response,
  signal: AbortSignal,
  options: { idleTimeoutMs?: number; onComment?: () => void } = {}
): AsyncGenerator<SSEEvent> {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    throw new Error("Expected an SSE response");
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let lastId: string | undefined;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const idleTimeoutMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (!signal.aborted) {
      // Only the wait for bytes counts, never the time the consumer holds an event. Cancelling
      // the reader ends the pending read, as an abort does.
      if (idleTimeoutMs > 0)
        timer = setTimeout(() => {
          idle = true;
          abort();
        }, idleTimeoutMs);
      const result = await reader.read();
      clearTimeout(timer);
      if (idle) throw new SSEIdleTimeoutError(idleTimeoutMs);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length > 2_000_000)
        throw new Error("SSE frame exceeds size limit");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "") {
          if (data.length)
            yield {
              event,
              data: data.join("\n"),
              ...(lastId === undefined ? {} : { id: lastId }),
            };
          event = "message";
          data = [];
          continue;
        }
        if (line.startsWith(":")) {
          options.onComment?.();
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "data") data.push(value);
        if (field === "id" && !value.includes("\0")) lastId = value;
        if (data.reduce((n, v) => n + v.length, 0) > 2_000_000)
          throw new Error("SSE event exceeds size limit");
      }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/**
 * Follows the SSE stream at `path`, reconnecting from the last event's id when a connection ends
 * or fails. A stream whose connections keep ending with nothing on them, no event and no
 * keepalive, `maxEmptyConnections` times in a row (default `SSE_MAX_EMPTY_CONNECTIONS`; `0`
 * never gives up), stops with `SSEStreamClosedError`, rather than reconnecting from the same
 * cursor forever.
 */
export async function* observeSSE(
  transport: Transport,
  path: string,
  options: {
    signal?: AbortSignal;
    cursor?: string;
    idleTimeoutMs?: number;
    maxEmptyConnections?: number;
  } = {}
): AsyncGenerator<SSEEvent> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const maxEmpty = options.maxEmptyConnections ?? SSE_MAX_EMPTY_CONNECTIONS;
  let cursor = options.cursor;
  let retry = 250;
  // The Runtime ended the stream because its token expired: reconnect
  // at once (the transport fetches a new token), but only once in a row.
  let closedByRuntime = 0;
  // Connections in a row that opened and ended with no event and no keepalive.
  let empty = 0;
  while (!signal.aborted) {
    let reconnectNow = false;
    let opened = false;
    let received = false;
    let idle = false;
    try {
      const response = await transport.request(path, {
        signal,
        headers: {
          Accept: "text/event-stream",
          ...(cursor ? { "Last-Event-ID": cursor } : {}),
        },
      });
      opened = true;
      const read = readSSE(response, signal, {
        ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
        onComment: () => {
          received = true;
        },
      });
      for await (const event of read) {
        received = true;
        if (event.event === "nylorun.closed") {
          closedByRuntime += 1;
          reconnectNow = closedByRuntime === 1;
          break;
        }
        retry = 250;
        closedByRuntime = 0;
        if (event.id) cursor = event.id;
        yield event;
      }
    } catch (error) {
      if (signal.aborted) return;
      // A silent stream is a dead connection: open a new one from the last event at once.
      if (error instanceof SSEIdleTimeoutError) idle = true;
      else if (
        error instanceof RuntimeError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        throw error;
    }
    if (signal.aborted) return;
    if (received) empty = 0;
    else if (opened && !idle && ++empty >= maxEmpty && maxEmpty > 0)
      throw new SSEStreamClosedError(empty, cursor);
    if (idle) continue;
    if (reconnectNow) continue;
    if (!signal.aborted) await delay(retry, signal).catch(() => {});
    retry = Math.min(30000, retry * 2);
  }
}
