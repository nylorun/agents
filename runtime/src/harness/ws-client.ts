/**
 * A harness's connection to core (F6.2): a WebSocket to the Harness API listener, with the
 * harness credential (`Authorization: Bearer`, `NYLORUN_HARNESS_TOKEN`) and the API version
 * header. Each connection runs one `createHarness`: it says `hello`, leases runs, and answers
 * core's `workspace.*` requests (`serve`). When the connection is lost its runs stop (core gives
 * their segments to the next advance, which resumes them by replay) and the client connects
 * again after a jittered backoff of 0.5 to 10 s.
 */
import { createChannel, type HarnessChannel, type RequestHandler } from "@nylorun/core/harness-api";
import { createHarness, type Harness, type HarnessOptions } from "@nylorun/harness/api";
import { WebSocket } from "ws";
import { HARNESS_API_HEADER, HARNESS_MAX_PAYLOAD, wsPort, type WsPortOptions } from "./ws-port.js";

export interface HarnessClientOptions
  extends Omit<HarnessOptions, "channel" | "logger"> {
  /** The Harness API, e.g. `ws://runtime:4200/nylorun/harness/v1` (`NYLORUN_HARNESS_URL`). */
  readonly url: string;
  /**
   * `NYLORUN_HARNESS_TOKEN`, or, for a pod sandbox's engine (F7.2), a function that answers
   * a current host token before each connection (it renews, or joins again).
   */
  readonly token: string | (() => Promise<string>);
  readonly logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** Answers core's requests (`workspace.*`). */
  readonly serve?: RequestHandler;
  /** Reconnect backoff bounds. Default 500 ms to 10 s. */
  readonly backoff?: { readonly minMs: number; readonly maxMs: number };
  readonly liveness?: Omit<WsPortOptions, "ping">;
}

export interface HarnessClient {
  /** Resolves once the first connection's `hello` is answered. */
  readonly ready: Promise<void>;
  /** Connected, and `hello` answered. */
  readonly connected: boolean;
  /** The current connection's channel, while there is one. */
  channel(): HarnessChannel | undefined;
  /** Stops leasing, gives its runs back (at most `waitMs`), and closes the connection. */
  stop(waitMs?: number): Promise<void>;
}

export function connectHarness(options: HarnessClientOptions): HarnessClient {
  const { logger } = options;
  const backoff = options.backoff ?? { minMs: 500, maxMs: 10_000 };
  let stopped = false;
  let connected = false;
  let current: { channel: HarnessChannel; harness: Harness } | undefined;
  let wake: (() => void) | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  const open = async () => {
    const token = typeof options.token === "string" ? options.token : await options.token();
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(options.url, {
        headers: { authorization: `Bearer ${token}`, [HARNESS_API_HEADER]: "1" },
        maxPayload: HARNESS_MAX_PAYLOAD,
        handshakeTimeout: 10_000,
      });
      socket.once("open", () => {
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("unexpected-response", (_request, response) => {
        socket.removeAllListeners("error");
        socket.on("error", () => undefined);
        reject(new Error(`The Harness API refused the connection: ${response.statusCode ?? 0}`));
        response.resume();
        socket.terminate();
      });
      socket.once("error", reject);
    });
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done() {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  const session = async () => {
    const socket = await open();
    if (stopped) return void socket.close(1000, "harness stopped");
    const channel = createChannel(wsPort(socket, options.liveness ?? {}), { validate: true });
    if (options.serve) channel.handle(options.serve);
    const harness = createHarness({ ...options, channel, logger });
    current = { channel, harness };
    const lost = new Promise<string>((resolve) => channel.onClose(resolve));
    try {
      await harness.start();
      connected = true;
      markReady();
      logger.info("harness_connected", { url: options.url });
      const reason = await lost;
      logger.warn("harness_connection_lost", { reason });
    } finally {
      connected = false;
      // The connection is gone: its runs were aborted with it; let them wind down.
      if (!stopped) await harness.stop(5_000);
      channel.close("reconnecting");
      current = undefined;
    }
  };

  const loop = (async () => {
    let attempt = 0;
    while (!stopped) {
      const started = Date.now();
      try {
        await session();
      } catch (error) {
        if (!stopped)
          logger.warn("harness_connect_failed", {
            url: options.url,
            message: error instanceof Error ? error.message : String(error),
          });
      }
      if (stopped) break;
      // A connection that lasted resets the backoff.
      if (Date.now() - started > backoff.maxMs) attempt = 0;
      const ceiling = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt);
      attempt += 1;
      await pause(backoff.minMs + Math.random() * Math.max(0, ceiling - backoff.minMs));
    }
  })();

  return {
    ready,
    get connected() {
      return connected;
    },
    channel: () => current?.channel,
    async stop(waitMs = 10_000) {
      stopped = true;
      wake?.();
      const live = current;
      if (live) {
        await live.harness.stop(waitMs);
        live.channel.close("harness stopped");
      }
      await loop;
    },
  };
}
