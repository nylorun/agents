/**
 * The Harness API's channel: requests and answers both ways, and one-way messages, over a
 * `Port` that carries frames. `memoryPorts` joins two ports in one process: by reference, or
 * through JSON with every frame validated (`json: true`, what a socket will carry).
 *
 * Frames: `{t:"req",id,m,p}`, `{t:"res",id,ok,r|e:{code,message}}`, `{t:"msg",m,p}`,
 * `{t:"abort",id}` (the requester gave up), `{t:"ping"}`.
 */
import type { HarnessErrorCode, HarnessMethod, ParamsOf, ResultOf } from "./messages.js";
import { HARNESS_ERROR_CODES } from "./messages.js";
import { HarnessApiError } from "./errors.js";
import { validateFrame, validateMessage, validateParams, validateResult } from "./schema.js";

export type Frame =
  | { readonly t: "req"; readonly id: number; readonly m: string; readonly p: unknown }
  | { readonly t: "res"; readonly id: number; readonly ok: true; readonly r: unknown }
  | {
      readonly t: "res";
      readonly id: number;
      readonly ok: false;
      readonly e: { readonly code: HarnessErrorCode; readonly message: string };
    }
  | { readonly t: "msg"; readonly m: string; readonly p: unknown }
  | { readonly t: "abort"; readonly id: number }
  | { readonly t: "ping" };

/** One end of a connection. */
export interface Port {
  send(frame: Frame): void;
  onFrame(listener: (frame: Frame) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(reason?: string): void;
}

export type RequestHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
export type MessageListener = (method: string, params: unknown) => void;

export interface HarnessChannel {
  request<M extends HarnessMethod>(method: M, params: ParamsOf<M>, signal?: AbortSignal): Promise<ResultOf<M>>;
  /** A one-way message. Dropped once the channel is closed. */
  notify(method: string, params: unknown): void;
  /** Answers the other side's requests. One handler per channel. */
  handle(handler: RequestHandler): void;
  listen(listener: MessageListener): void;
  onClose(listener: (reason: string) => void): void;
  close(reason?: string): void;
  readonly closed: boolean;
}

/** Wraps a port. With `validate`, every request, answer and message is checked against its schema. */
export function createChannel(port: Port, options: { validate?: boolean } = {}): HarnessChannel {
  const validate = options.validate === true;
  let nextId = 1;
  let closed = false;
  let handler: RequestHandler | undefined;
  const listeners: MessageListener[] = [];
  const closers: ((reason: string) => void)[] = [];
  const pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: unknown): void }>();
  const serving = new Map<number, AbortController>();

  const answer = async (id: number, method: string, params: unknown) => {
    const controller = new AbortController();
    serving.set(id, controller);
    try {
      if (!handler) throw new HarnessApiError("invalid", `No handler for ${method}`);
      if (validate) validateParams(method, params);
      const result = await handler(method, params, controller.signal);
      if (validate) validateResult(method, result);
      if (!closed) port.send({ t: "res", id, ok: true, r: result ?? {} });
    } catch (error) {
      if (!closed) port.send({ t: "res", id, ok: false, e: wireError(error) });
    } finally {
      serving.delete(id);
    }
  };

  port.onFrame((frame) => {
    if (validate)
      try {
        validateFrame(frame);
      } catch (error) {
        // A peer that sends malformed frames is not one to keep talking to.
        const id = (frame as { t?: unknown; id?: unknown }).t === "req" ? (frame as { id?: unknown }).id : undefined;
        if (typeof id === "number" && !closed) port.send({ t: "res", id, ok: false, e: wireError(error) });
        else {
          const reason = `invalid frame: ${(error as Error).message}`;
          port.close(reason);
          shut(reason);
        }
        return;
      }
    switch (frame.t) {
      case "req":
        void answer(frame.id, frame.m, frame.p);
        return;
      case "res": {
        const call = pending.get(frame.id);
        if (!call) return;
        pending.delete(frame.id);
        if (!frame.ok) call.reject(new HarnessApiError(frame.e.code, frame.e.message));
        else {
          try {
            if (validate) validateResult(call.method, frame.r);
            call.resolve(frame.r);
          } catch (error) {
            call.reject(error);
          }
        }
        return;
      }
      case "msg":
        try {
          if (validate) validateMessage(frame.m, frame.p);
        } catch {
          return;
        }
        for (const listener of listeners) listener(frame.m, frame.p);
        return;
      case "abort":
        serving.get(frame.id)?.abort(new HarnessApiError("unavailable", "The requester gave up"));
        return;
      case "ping":
        return;
    }
  });

  const shut = (reason: string) => {
    if (closed) return;
    closed = true;
    const error = new HarnessApiError("unavailable", `The Harness API connection closed: ${reason}`);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    for (const controller of serving.values()) controller.abort(error);
    serving.clear();
    for (const closer of closers) closer(reason);
  };
  port.onClose(shut);

  return {
    get closed() {
      return closed;
    },
    request(method, params, signal) {
      if (closed)
        return Promise.reject(new HarnessApiError("unavailable", "The Harness API connection is closed"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (validate)
        try {
          validateParams(method, params);
        } catch (error) {
          return Promise.reject(error);
        }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (!pending.delete(id)) return;
          if (!closed) port.send({ t: "abort", id });
          reject(signal!.reason);
        };
        pending.set(id, {
          method,
          resolve: (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value as never);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        port.send({ t: "req", id, m: method, p: params });
      });
    },
    notify(method, params) {
      if (closed) return;
      if (validate) validateMessage(method, params);
      port.send({ t: "msg", m: method, p: params });
    },
    handle(next) {
      handler = next;
    },
    listen(listener) {
      listeners.push(listener);
    },
    onClose(listener) {
      if (closed) listener("closed");
      else closers.push(listener);
    },
    close(reason = "closed") {
      if (closed) return;
      port.close(reason);
      shut(reason);
    },
  };
}

function wireError(error: unknown): { code: HarnessErrorCode; message: string } {
  if (error instanceof HarnessApiError) return { code: error.code, message: error.message };
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: HARNESS_ERROR_CODES.includes(code as HarnessErrorCode) ? (code as HarnessErrorCode) : "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

export interface MemoryPortsOptions {
  /** Serialize every frame through JSON and validate it, as a socket would. */
  json?: boolean;
  /** Sees each frame as it crosses, with its size in JSON mode. For tests and benchmarks. */
  tap?(frame: Frame, from: "harness" | "core", bytes?: number): void;
}

/** Two joined ports in one process: `harness` and `core`. Frames arrive in order, asynchronously. */
export function memoryPorts(options: MemoryPortsOptions = {}): { harness: Port; core: Port } {
  const encoder = options.json ? new TextEncoder() : undefined;
  const end = (from: "harness" | "core") => {
    const frames: ((frame: Frame) => void)[] = [];
    const closes: ((reason: string) => void)[] = [];
    return { from, frames, closes, closed: false };
  };
  const ends = { harness: end("harness"), core: end("core") };
  const port = (self: ReturnType<typeof end>, peer: ReturnType<typeof end>): Port => ({
    send(frame) {
      if (self.closed || peer.closed) return;
      let sent = frame;
      let bytes: number | undefined;
      if (encoder) {
        const text = JSON.stringify(frame);
        bytes = encoder.encode(text).length;
        sent = JSON.parse(text) as Frame;
      }
      options.tap?.(frame, self.from, bytes);
      queueMicrotask(() => {
        if (!peer.closed) for (const listener of peer.frames) listener(sent);
      });
    },
    onFrame(listener) {
      self.frames.push(listener);
    },
    onClose(listener) {
      self.closes.push(listener);
    },
    close(reason = "closed") {
      for (const side of [self, peer]) {
        if (side.closed) continue;
        side.closed = true;
        queueMicrotask(() => {
          for (const listener of side.closes) listener(reason);
        });
      }
    },
  });
  return { harness: port(ends.harness, ends.core), core: port(ends.core, ends.harness) };
}

/** `memoryPorts` wrapped in channels; JSON mode validates on both ends. */
export function memoryChannels(options: MemoryPortsOptions = {}): {
  harness: HarnessChannel;
  core: HarnessChannel;
} {
  const ports = memoryPorts(options);
  const validate = options.json === true;
  return {
    harness: createChannel(ports.harness, { validate }),
    core: createChannel(ports.core, { validate }),
  };
}
