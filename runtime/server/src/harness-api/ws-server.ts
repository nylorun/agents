/**
 * The Harness API listener (F6.2): core's own port for harnesses (`NYLORUN_HARNESS_LISTEN_*`,
 * default 4200), apart from the Runtime and Management APIs. It accepts the harness credential
 * (`NYLORUN_HARNESS_TOKEN`), and nothing else does; nothing else is served here.
 *
 * An upgrade is accepted only on `/nylorun/harness/v1`, with a `Host` in the allowlist (421),
 * `Authorization: Bearer <token>` (compared in constant time; 401) and `Nylorun-Harness-Api: 1`
 * (426), while the Tenant is open (503). Frames are at most 64 MiB and every one is validated
 * (`createChannel({ validate: true })`). Core pings every 30 s and drops a harness silent for
 * 90 s; the connection then counts as lost (`connection.lost`).
 *
 * Sandbox pods (F7.2, D42) reach this listener too, on the Docker host's published port, and hold
 * no harness token. A pod's engine exchanges its join token for a host token with `POST
 * /nylorun/harness/v1/host/join` (`{ sandboxId, podUid, joinToken }`), renews it with `POST
 * .../host/renew` (`Authorization: Bearer <host token>`), and upgrades with the host token as
 * its bearer: that connection hosts its sandbox alone (`HarnessPeer.host`). Both answer
 * `{ hostToken, egressToken, sandboxId, epoch, expiresAt, caCertificate }` (the egress CA, R2c),
 * and a join adds the disk's `setup` (R2d step 2). With its host token the engine also reads and
 * reports its setup (`GET|POST .../host/setup`) and reads its input files (`GET
 * .../host/files/{index}[/{path}]`). Every refusal is the same 401. The harness token is never
 * accepted as a host token, nor a host token anywhere but here.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
import { tokenType } from "../tenant/jwt.js";
import { HOST_TOKEN_TYP } from "../tenant/host-token.js";
import { HostAuthError, type HostAuthority, type HostJoinRequest } from "../sandbox/join.js";
import { parseSetupReport } from "../sandbox/setup.js";
import type { HarnessPeer } from "./server.js";

/** Where a pod's engine exchanges its join token, and renews its host token. */
export const HOST_JOIN_PATH = `${HARNESS_API_PATH}/host/join`;
export const HOST_RENEW_PATH = `${HARNESS_API_PATH}/host/renew`;
/** Where a pod's engine reads its setup and reports it (R2d step 2, `sandbox/setup.ts`). */
export const HOST_SETUP_PATH = `${HARNESS_API_PATH}/host/setup`;
/** Where it reads its input files: `/{index}`, and a folder's file `/{index}/{path}`. */
export const HOST_FILES_PATH = `${HARNESS_API_PATH}/host/files`;
/** A join's body is small. */
const MAX_JOIN_BODY = 8 * 1024;
/** A setup report carries the end of a command's output. */
const MAX_REPORT_BODY = 64 * 1024;

/** Attaches a harness's channel to the open Tenant; returns a function that detaches it. */
export type HarnessAttach = (channel: HarnessChannel, peer: HarnessPeer) => () => void;

export interface HarnessListenerOptions {
  readonly host: string;
  readonly port: number;
  /** Exact `Host` values accepted (lowercase `name:port`); the loopback forms of the bound port are added. */
  readonly allowedHosts: readonly string[];
  /** `NYLORUN_HARNESS_TOKEN`; absent, only sandbox pods' host tokens are accepted. */
  readonly token?: string;
  /** The open Tenant's `attachHarness`, or undefined while there is none. */
  readonly attach: () => Promise<HarnessAttach | undefined>;
  /** The open Tenant's host authority (sandbox pods, F7.2), or undefined without one. */
  readonly hosts?: () => Promise<HostAuthority | undefined>;
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

function bearerOf(header: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "")?.[1];
}

function bearerMatches(header: string | undefined, token: string | undefined): boolean {
  const presented = bearerOf(header);
  if (presented === undefined || token === undefined) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export async function startHarnessListener(options: HarnessListenerOptions): Promise<HarnessListener> {
  let closing = false;
  // A log line must never throw out of a socket callback (a closed Tenant's log is gone).
  const log =
    (level: "info" | "warn") =>
    (message: string, fields?: Record<string, unknown>) => {
      if (closing) return;
      try {
        options.logger[level](message, fields);
      } catch {
        /* nowhere to log */
      }
    };
  const logger = { info: log("info"), warn: log("warn") };
  const wss = new WebSocketServer({ noServer: true, maxPayload: HARNESS_MAX_PAYLOAD });
  let allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));

  const reply = (response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, {
      connection: "close",
      "cache-control": "no-store",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    });
    response.end(text);
  };
  const readBody = (request: IncomingMessage, max = MAX_JOIN_BODY) =>
    new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          reject(new HostAuthError(400, "The body is too large"));
          request.destroy();
        } else chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });

  /** `host/join` and `host/renew` (F7.2); everything else here is the WebSocket upgrade. */
  const serveHost = async (request: IncomingMessage, response: ServerResponse, path: string) => {
    if (request.method !== "POST") return reply(response, 405, undefined, { allow: "POST" });
    if (!allowed.has(String(request.headers.host ?? "").toLowerCase())) return reply(response, 421);
    const authority = await options.hosts?.().catch(() => undefined);
    if (!authority || closing) return reply(response, 503, { error: { code: "unavailable", message: "Try again" } });
    try {
      const answer =
        path === HOST_JOIN_PATH
          ? await authority.join(parseJoin(await readBody(request)))
          : await authority.renew(bearerOf(request.headers.authorization) ?? "");
      return reply(response, 200, answer);
    } catch (error) {
      if (error instanceof HostAuthError) {
        if (error.reason) logger.warn("sandbox_host_refused", { path, reason: error.reason });
        return reply(
          response,
          error.status,
          { error: { code: error.status === 401 ? "unauthorized" : "invalid", message: error.message } },
          error.status === 401 ? { "www-authenticate": "Bearer" } : {}
        );
      }
      logger.warn("sandbox_host_failed", { path, message: error instanceof Error ? error.message : String(error) });
      return reply(response, 503, { error: { code: "unavailable", message: "Try again" } });
    }
  };

  /** A pod's setup and input files (R2d step 2), with its host token. */
  const serveSetup = async (request: IncomingMessage, response: ServerResponse, path: string) => {
    if (!allowed.has(String(request.headers.host ?? "").toLowerCase())) return reply(response, 421);
    const authority = await options.hosts?.().catch(() => undefined);
    if (!authority || closing) return reply(response, 503, { error: { code: "unavailable", message: "Try again" } });
    const token = bearerOf(request.headers.authorization) ?? "";
    try {
      if (path === HOST_SETUP_PATH) {
        if (request.method === "GET") return reply(response, 200, await authority.setup(token));
        if (request.method !== "POST") return reply(response, 405, undefined, { allow: "GET, POST" });
        const report = parseSetupReport(JSON.parse(await readBody(request, MAX_REPORT_BODY)));
        if (!report) throw new HostAuthError(400, "The report is malformed");
        await authority.reportSetup(token, report);
        return reply(response, 200, {});
      }
      if (request.method !== "GET") return reply(response, 405, undefined, { allow: "GET" });
      const [index, ...rest] = path.slice(HOST_FILES_PATH.length + 1).split("/");
      if (!/^\d{1,2}$/.test(index ?? "")) return reply(response, 404);
      const file = await authority.setupFile(
        token,
        Number(index),
        rest.length === 0 ? undefined : rest.map((part) => decodeURIComponent(part)).join("/"),
      );
      if (!file) return reply(response, 404);
      if (file.kind === "folder")
        return reply(response, 200, { entries: file.entries }, { "x-nylorun-artifact-kind": "folder" });
      response.writeHead(200, {
        connection: "close",
        "cache-control": "no-store",
        "content-type": file.contentType,
        "x-nylorun-artifact-kind": "file",
      });
      for await (const chunk of file.body as unknown as AsyncIterable<Uint8Array>) response.write(chunk);
      response.end();
    } catch (error) {
      if (error instanceof HostAuthError) {
        if (error.reason) logger.warn("sandbox_host_refused", { path, reason: error.reason });
        return reply(
          response,
          error.status,
          { error: { code: error.status === 401 ? "unauthorized" : "invalid", message: error.message } },
          error.status === 401 ? { "www-authenticate": "Bearer" } : {}
        );
      }
      if (error instanceof SyntaxError) return reply(response, 400, { error: { code: "invalid", message: "Not JSON" } });
      logger.warn("sandbox_host_failed", { path, message: error instanceof Error ? error.message : String(error) });
      if (response.headersSent) return void response.destroy();
      return reply(response, 503, { error: { code: "unavailable", message: "Try again" } });
    }
  };

  // Plain requests get nothing but the pods' join, renewal and setup: the listener speaks the Harness API.
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://harness.local").pathname;
    if (closing) return reply(response, 503);
    if ((path === HOST_JOIN_PATH || path === HOST_RENEW_PATH) && options.hosts) {
      void serveHost(request, response, path);
      return;
    }
    if ((path === HOST_SETUP_PATH || path.startsWith(`${HOST_FILES_PATH}/`)) && options.hosts) {
      void serveSetup(request, response, path);
      return;
    }
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
    const bearer = bearerOf(request.headers.authorization);
    // A pod's host token (F7.2): checked against its sandbox before the upgrade.
    const hostToken = bearer !== undefined && options.hosts && tokenType(bearer) === HOST_TOKEN_TYP;
    if (!hostToken && !bearerMatches(request.headers.authorization, options.token))
      return refuse(socket, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    if (request.headers[HARNESS_API_HEADER] !== "1")
      return refuse(socket, 426, "Upgrade Required", { [HARNESS_API_HEADER]: "1" });
    const host = hostToken
      ? options.hosts!().then(async (authority) => {
          if (!authority) return undefined;
          const claims = await authority.verify(bearer);
          return { sandboxId: claims.sandboxId, epoch: claims.epoch };
        })
      : Promise.resolve(undefined);
    void Promise.all([options.attach(), host]).then(
      ([attach, hosted]) => {
        if (!attach || closing || (hostToken && !hosted)) return refuse(socket, 503, "Service Unavailable");
        wss.handleUpgrade(request, socket, head, (ws) => {
          const peer = {
            name: hosted
              ? `sandbox ${hosted.sandboxId}@${request.socket.remoteAddress ?? "unknown"}`
              : `harness@${request.socket.remoteAddress ?? "unknown"}`,
            ...(hosted ? { host: hosted } : {}),
          };
          const channel = createChannel(wsPort(ws, { ...options.liveness, ping: true }), { validate: true });
          const detach = attach(channel, peer);
          channel.onClose((reason) => {
            detach();
            logger.info("harness_disconnected", { peer: peer.name, reason });
          });
          logger.info("harness_connected", { peer: peer.name });
        });
      },
      (error: unknown) => {
        if (error instanceof HostAuthError) {
          if (error.reason) logger.warn("sandbox_host_refused", { path, reason: error.reason });
          return refuse(socket, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
        }
        return refuse(socket, 503, "Service Unavailable");
      }
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

/** A join's body, or a 400. */
function parseJoin(text: string): HostJoinRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HostAuthError(400, "A join is JSON: { sandboxId, podUid, joinToken }");
  }
  const { sandboxId, podUid, joinToken, volumeId } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof sandboxId !== "string" ||
    typeof podUid !== "string" ||
    typeof joinToken !== "string" ||
    (volumeId !== undefined && typeof volumeId !== "string")
  )
    throw new HostAuthError(400, "A join is JSON: { sandboxId, podUid, joinToken, volumeId? }");
  return { sandboxId, podUid, joinToken, ...(volumeId === undefined ? {} : { volumeId }) };
}
