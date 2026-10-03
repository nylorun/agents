/**
 * The Harness API listener (F6.2): core's own port for harnesses (`NYLORUN_HARNESS_LISTEN_*`,
 * default 4200), apart from the Tenant and Admin APIs. It accepts the harness credential
 * (`NYLORUN_HARNESS_TOKEN`), and nothing else does; nothing else is served here.
 *
 * An upgrade is accepted only on `/nylorun/harness/v1`, with a `Host` in the allowlist (421),
 * `Authorization: Bearer <token>` (compared in constant time; 401) and `Nylorun-Harness-Api: 1`
 * (426), while the Tenant is open (503). Frames are at most 64 MiB and every one is validated
 * (`createChannel({ validate: true })`). Core pings every 30 s and drops a harness silent for
 * 90 s; the connection then counts as lost (`connection.lost`).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createChannel, type HarnessChannel } from "@nylorun/core/harness-api";
import { WebSocketServer } from "ws";
import {
  HARNESS_API_HEADER,
  HARNESS_API_PATH,
  HARNESS_MAX_PAYLOAD,
  wsPort,
  type WsPortOptions,
} from "../harness/ws-port.js";
import type { HarnessPeer } from "./server.js";

/** Attaches a harness's channel to the open Tenant; returns a function that detaches it. */
export type HarnessAttach = (channel: HarnessChannel, peer: HarnessPeer) => () => void;

export interface HarnessListenerOptions {
  readonly host: string;
  readonly port: number;
  /** Exact `Host` values accepted (lowercase `name:port`); the loopback forms of the bound port are added. */
  readonly allowedHosts: readonly string[];
  /** `NYLORUN_HARNESS_TOKEN`. */
  readonly token: string;
  /** The open Tenant's `attachHarness`, or undefined while there is none. */
  readonly attach: () => Promise<HarnessAttach | undefined>;
  readonly logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  readonly liveness?: Omit<WsPortOptions, "ping">;
}

export interface HarnessListener {
  /** `ws://host:port/nylorun/harness/v1`. */
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

function refuse(socket: Socket, status: number, text: string, headers: Record<string, string> = {}): void {
  const lines = [
    `HTTP/1.1 ${status} ${text}`,
    "Connection: close",
    "Content-Length: 0",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.end(`${lines.join("\r\n")}\r\n\r\n`);
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "")?.[1];
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export async function startHarnessListener(options: HarnessListenerOptions): Promise<HarnessListener> {
  const { logger } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: HARNESS_MAX_PAYLOAD });
  let allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  let closing = false;

  // Plain requests get nothing: the listener speaks only the Harness API.
  const server = createServer((_request, response) => {
    response.writeHead(426, { connection: "close", upgrade: "websocket" });
    response.end();
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => undefined);
    const path = new URL(request.url ?? "/", "http://harness.local").pathname;
    if (closing) return refuse(socket, 503, "Service Unavailable");
    if (path !== HARNESS_API_PATH) return refuse(socket, 404, "Not Found");
    if (!allowed.has(String(request.headers.host ?? "").toLowerCase()))
      return refuse(socket, 421, "Misdirected Request");
    if (!bearerMatches(request.headers.authorization, options.token))
      return refuse(socket, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    if (request.headers[HARNESS_API_HEADER] !== "1")
      return refuse(socket, 426, "Upgrade Required", { [HARNESS_API_HEADER]: "1" });
    void options.attach().then(
      (attach) => {
        if (!attach || closing) return refuse(socket, 503, "Service Unavailable");
        wss.handleUpgrade(request, socket, head, (ws) => {
          const peer = { name: `harness@${request.socket.remoteAddress ?? "unknown"}` };
          const channel = createChannel(wsPort(ws, { ...options.liveness, ping: true }), { validate: true });
          const detach = attach(channel, peer);
          channel.onClose((reason) => {
            detach();
            logger.info("harness_disconnected", { peer: peer.name, reason });
          });
          logger.info("harness_connected", { peer: peer.name });
        });
      },
      () => refuse(socket, 503, "Service Unavailable")
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      server.on("error", (error) => logger.warn("harness_listener_error", { message: error.message }));
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  allowed = new Set([...allowed, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  return {
    url: `ws://${host}:${port}${HARNESS_API_PATH}`,
    server,
    async close() {
      closing = true;
      for (const client of wss.clients) client.close(1001, "core is stopping");
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, 1_000).unref();
      await closed;
      wss.close();
    },
  };
}
