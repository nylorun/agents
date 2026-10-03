/**
 * The Harness API over a WebSocket (F6.2): one JSON text message per frame. Either end watches
 * the connection: core pings every `pingMs` (30 s), the harness answers (`ws` does it), and an
 * end that hears nothing from the other for `silenceMs` (90 s) drops the connection. A message
 * that is not JSON closes it (1007); `createChannel({ validate: true })` checks the rest.
 */
import type { Frame, Port } from "@nylorun/core/harness-api";
import { WebSocket } from "ws";

/** The URL path of the Harness API, and the header naming its version. */
export const HARNESS_API_PATH = "/nylorun/harness/v1";
export const HARNESS_API_HEADER = "nylorun-harness-api";

/** Largest frame either end accepts. */
export const HARNESS_MAX_PAYLOAD = 64 * 1024 * 1024;

export const DEFAULT_PING_MS = 30_000;
export const DEFAULT_SILENCE_MS = 90_000;

export interface WsPortOptions {
  /** Send pings (core's end). */
  readonly ping?: boolean;
  readonly pingMs?: number;
  readonly silenceMs?: number;
}

export function wsPort(socket: WebSocket, options: WsPortOptions = {}): Port {
  const frames: ((frame: Frame) => void)[] = [];
  const closes: ((reason: string) => void)[] = [];
  const silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
  let lastHeard = Date.now();
  let closed = false;
  let reason = "closed";
  const heard = () => {
    lastHeard = Date.now();
  };
  const watch = setInterval(() => {
    if (Date.now() - lastHeard > silenceMs) {
      reason = `nothing heard for ${Math.round(silenceMs / 1000)} s`;
      socket.terminate();
    } else if (options.ping && socket.readyState === WebSocket.OPEN) socket.ping();
  }, Math.min(options.pingMs ?? DEFAULT_PING_MS, silenceMs));
  watch.unref();

  socket.on("ping", heard);
  socket.on("pong", heard);
  socket.on("message", (data, binary) => {
    heard();
    let frame: Frame;
    try {
      if (binary) throw new Error("binary message");
      frame = JSON.parse(data.toString()) as Frame;
    } catch {
      reason = "a message that is not a JSON frame";
      socket.close(1007, "Harness API frames are JSON text");
      return;
    }
    for (const listener of frames) listener(frame);
  });
  socket.on("error", (error) => {
    reason = error.message;
  });
  socket.on("close", (code, why) => {
    clearInterval(watch);
    if (closed) return;
    closed = true;
    const said = why.toString();
    const message = said || (code === 1000 ? reason : `${reason} (${code})`);
    for (const listener of closes) listener(message);
  });

  return {
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    },
    onFrame(listener) {
      frames.push(listener);
    },
    onClose(listener) {
      closes.push(listener);
    },
    close(why = "closed") {
      reason = why;
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
      // A close reason is at most 123 bytes.
      socket.close(1000, Buffer.from(why).subarray(0, 120).toString());
    },
  };
}
