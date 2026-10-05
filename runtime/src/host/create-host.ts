import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { getRequestListener, RequestError } from "@hono/node-server";
import type { Logger, TenantModule } from "../tenant/types.js";
import { createHostApp } from "./app.js";
import type { HostConfigFile } from "./config.js";
import type { ContainerListen } from "./stack-config.js";
import {
  bindListener as bind,
  EXIT_NON_LOOPBACK,
  headerValue,
  HostListenError,
  isAllowedRequestHost,
  isLoopbackHost,
  pathnameIsLogged,
  redactRoutePath,
  rejectedResponse,
  sendRejected,
} from "./http.js";

export interface CreateHostOptions {
  hostRoot: string;
  module: TenantModule;
  config: HostConfigFile;
  logger: Logger;
  /** Diagnostic package version of `@nylorun/core` for `/health`. */
  coreVersion: string;
  /** Process id reported by `/health`. Defaults to `process.pid`. */
  pid?: number;
  /**
   * Container mode: bind this address and port instead of host.json's, and
   * accept only `allowedHosts` in the `Host` check (replacing the
   * loopback-only rule). host.json then describes the client-facing address.
   */
  listen?: ContainerListen;
  /**
   * Infrastructure readiness (`infra/readiness.ts`). `/ready` adds its checks
   * and answers 503 while it reports not ok. Default: the listener and the
   * Tenant only.
   */
  readiness?: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  /**
   * Shutdown steps around closing the Tenant. `close()` runs them whatever asked for it
   * (SIGTERM in `host/main.ts`): the listener stops, then
   * `beforeTenants` (stop the Worker so no advance starts on the closing Tenant), the Tenant
   * closes, then `afterTenants` (end the infrastructure clients). A failing step is logged
   * and shutdown goes on.
   */
  shutdown?: {
    beforeTenants?(): Promise<void>;
    afterTenants?(): Promise<void>;
  };
}

export interface HostServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  /** Settles once `close()` has finished, whatever called it. */
  readonly closed: Promise<void>;
  readonly url: string;
}

export function createHost(options: CreateHostOptions): HostServer {
  const { module, config, logger, coreVersion } = options;
  const pid = options.pid ?? process.pid;
  const containerListen = options.listen;
  const bindHost = containerListen?.host ?? config.host;
  const bindPort = containerListen?.port ?? config.port;
  let server: Server | undefined;
  let url = "";
  let listenPort = bindPort;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const app = createHostApp({
    module,
    logger,
    hostId: config.hostId,
    coreVersion,
    pid,
    ...(options.readiness ? { readiness: options.readiness } : {}),
    listening: () => Boolean(server?.listening),
    closing: () => closing,
  });

  /** Where requests go once their `Host` header checks out. */
  const pipeline = () =>
    getRequestListener(
      async (request, node) => alreadySent(await app.fetch(request, node)),
      {
        // The Runtime runs inside other processes (`startEphemeralRuntime`): leave their
        // `Request` and `Response` alone.
        overrideGlobalObjects: false,
        // A request target `@hono/node-server` cannot make a URL of, such as `*`.
        errorHandler: (error) => {
          if (error instanceof RequestError)
            return rejectedResponse(400, "invalid_request", "Invalid request target");
          logger.error("request_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return rejectedResponse(500, "internal_error", "Internal error");
        },
      },
    );

  /** The `Host` values the listener accepts. */
  const hostAllowed = (hostHeader: string | undefined) =>
    isAllowedRequestHost(hostHeader, {
      port: listenPort,
      host: config.host,
      allowNonLoopback: config.allowNonLoopback,
      ...(containerListen ? { allowedHosts: containerListen.allowedHosts } : {}),
    });

  /** Responses not yet finished; shutdown ends the streams among them. */
  const inFlight = new Set<ServerResponse>();
  const serve = () => {
    const next = pipeline();
    return (req: IncomingMessage, res: ServerResponse) => {
      const started = Date.now();
      inFlight.add(res);
      res.once("close", () => inFlight.delete(res));
      // D§11: `Host` first, before anything reads the request.
      if (hostAllowed(headerValue(req, "host"))) return void next(req, res);
      sendRejected(
        res,
        421,
        "host_rejected",
        "Host header is not an allowed loopback or configured address",
      );
      if (pathnameIsLogged(req.url))
        logger.info("request", {
          status: 421,
          durationMs: Date.now() - started,
          path: redactRoutePath(new URL(req.url ?? "/", "http://runtime.local").pathname),
          method: req.method,
        });
    };
  };

  /** Binds `listening`; once bound, a listener error is logged rather than lost. */
  const bindListener = (listening: Server, port: number, host: string) =>
    bind(listening, port, host, (error) =>
      logger.error("listener_error", { error: error.message }),
    );

  async function listen(): Promise<void> {
    if (server) throw new Error("Already listening");
    // Container mode binds a non-loopback address behind an explicit Host
    // allowlist; otherwise only loopback unless host.json allows more.
    if (
      !containerListen &&
      !config.allowNonLoopback &&
      !isLoopbackHost(config.host)
    ) {
      throw new HostListenError(
        `Refusing to bind non-loopback host ${config.host} without allowNonLoopback`,
        EXIT_NON_LOOPBACK,
      );
    }
    server = createServer(serve());
    await bindListener(server, bindPort, bindHost);
    const address = server.address();
    listenPort =
      typeof address === "object" && address ? address.port : bindPort;
    url = `http://${bindHost}:${listenPort}`;
    // The Tenant opens once the listener is bound: `/ready` answers while it opens.
    await module.start();
    logger.info("host_listening", { hostId: config.hostId, url, pid });
  }

  const step = async (name: string, run: (() => Promise<void>) | undefined) => {
    try {
      await run?.();
    } catch (error) {
      logger.error("host_shutdown_step_failed", {
        step: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      logger.info("host_shutdown", { hostId: config.hostId });
      const listeners = server ? [server] : [];
      const stopped = Promise.all(
        listeners.map(
          (listening) =>
            new Promise<void>((resolve) => {
              listening.close(() => resolve());
              listening.closeIdleConnections();
            }),
        ),
      );
      // A stream never finishes by itself, and a listener closes only once every connection
      // has: end the streams, close their connections once idle, let other requests finish,
      // then cut what is left.
      const streams = [...inFlight].filter(isStreaming);
      void Promise.all(
        streams.map((response) => {
          const done = new Promise((resolve) => response.once("close", resolve));
          response.end();
          return done;
        }),
      ).then(() => {
        for (const listening of listeners) listening.closeIdleConnections();
      });
      let grace: NodeJS.Timeout | undefined;
      const graceful = await Promise.race([
        stopped.then(() => true),
        new Promise<false>((resolve) => {
          grace = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
          grace.unref();
        }),
      ]);
      clearTimeout(grace);
      if (!graceful) {
        logger.warn("host_shutdown_forced", { openResponses: inFlight.size });
        for (const listening of listeners) listening.closeAllConnections();
        await stopped;
      }
      server = undefined;
      await step("beforeTenants", options.shutdown?.beforeTenants);
      await step("tenants", () => module.close());
      await step("afterTenants", options.shutdown?.afterTenants);
    })().finally(settleClosed);
    return closePromise;
  }

  return {
    listen,
    close,
    closed,
    get url() {
      return url;
    },
  };
}

/**
 * An answer already written to the Node response. `@hono/node-server` skips writing one that
 * says so in its headers, unless it is its own `Response` class, which a process that ran its
 * `serve()` has as the global one: it writes those again. This is never that class.
 */
const SENT = {
  status: 200,
  headers: new Headers({ "x-hono-already-sent": "true" }),
  body: null,
} as unknown as Response;

function alreadySent(response: Response): Response {
  return response.headers.has("x-hono-already-sent") ? SENT : response;
}

/** How long shutdown waits for requests in progress before closing their connections. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * A response that has started and not ended is a stream: JSON answers are written and ended
 * at once. (`getHeader` cannot tell, since streams pass their headers to `writeHead`.)
 */
function isStreaming(response: ServerResponse): boolean {
  return response.headersSent && !response.writableEnded;
}

