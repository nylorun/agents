import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { getRequestListener, RequestError } from "@hono/node-server";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AdminStatusSchema } from "@nylorun/core/contracts";
import type { Logger, TenantModule } from "../tenant/types.js";
import { adminDocument } from "../api/openapi.js";
import { createAdminApi } from "./admin-api.js";
import { createHostApp, type HostBindings } from "./app.js";
import type { HostConfigFile, HostCredentialsFile } from "./config.js";
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
import { RUNTIME_VERSION } from "../version.js";

export interface CreateHostOptions {
  hostRoot: string;
  module: TenantModule;
  config: HostConfigFile;
  credentials: HostCredentialsFile;
  logger: Logger;
  /** Diagnostic package version of `@nylorun/core` for `/health`. */
  coreVersion: string;
  /** Process id reported by `/health` and admin host status. Defaults to `process.pid`. */
  pid?: number;
  /**
   * Container mode: bind this address and port instead of host.json's, and
   * accept only `allowedHosts` in the `Host` check (replacing the
   * loopback-only rule). host.json then describes the client-facing address.
   */
  listen?: ContainerListen;
  /**
   * The client-facing URL `/v1/admin/status` reports as `host.url`
   * (`NYLORUN_PUBLIC_URL`). Defaults to the bound address, which in container
   * mode is `http://0.0.0.0:4000`.
   */
  publicUrl?: string;
  /**
   * Browser access (Host feature `browser-access`): requests with an `Origin` may reach Tenant
   * routes, where the publishable key's origin allowlist decides. Off by default: every
   * `Origin` is `403 origin_rejected`, as before. Admin routes, `/health` and `/ready` refuse
   * `Origin` either way.
   */
  browserAccess?: boolean;
  /**
   * The operator listener: the Admin API (and the Tenant API, never with browser access) on
   * its own address, kept off the network that reaches the Tenant API. When set, the main
   * listener is public and answers admin routes with the opaque 404. Absent: one listener
   * serves everything, as before.
   */
  operator?: OperatorListen;
  /**
   * Infrastructure readiness (`infra/readiness.ts`). `/ready` adds its checks
   * and answers 503 while it reports not ok. Default: the listener and the
   * Tenant only.
   */
  readiness?: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  /**
   * Shutdown steps around closing the Tenant. `close()` runs them whatever asked for it
   * (SIGTERM in `host/main.ts`, `POST /v1/admin/host/shutdown`): the listener stops, then
   * `beforeTenants` (stop the Worker so no advance starts on the closing Tenant), the Tenant
   * closes, then `afterTenants` (end the infrastructure clients). A failing step is logged
   * and shutdown goes on.
   */
  shutdown?: {
    beforeTenants?(): Promise<void>;
    afterTenants?(): Promise<void>;
  };
}

/** Where the operator listener binds, and the `Host` values it accepts. */
export interface OperatorListen {
  host: string;
  port: number;
  /** Exact `Host` values (lowercase `name:port`); absent means the loopback forms of the port. */
  allowedHosts?: readonly string[];
}

/**
 * What a listener serves. `combined`: everything (one port). `public`: the Tenant API, with
 * browser access when enabled; admin routes are the opaque 404. `operator`: the Admin API and
 * the Tenant API, never to browsers.
 */
export type ListenerRole = "combined" | "public" | "operator";

export interface HostServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  /** Settles once `close()` has finished, whatever called it. */
  readonly closed: Promise<void>;
  readonly url: string;
  /** Where the Admin API answers: the operator listener, or `url` when there is one listener. */
  readonly adminUrl: string;
}

export { adminKeyMatches } from "./http.js";

export function createHost(options: CreateHostOptions): HostServer {
  const {
    hostRoot,
    module,
    config,
    credentials,
    logger,
    coreVersion,
  } = options;
  const pid = options.pid ?? process.pid;
  const containerListen = options.listen;
  const bindHost = containerListen?.host ?? config.host;
  const bindPort = containerListen?.port ?? config.port;
  let server: Server | undefined;
  let url = "";
  let listenPort = bindPort;
  const operator = options.operator;
  let operatorServer: Server | undefined;
  let operatorPort = operator?.port ?? 0;
  let adminUrl = "";
  const mainRole: ListenerRole = operator ? "public" : "combined";
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const adminStatusBody = async () => {
    const aggregate = await module.summarize();
    return AdminStatusSchema.parse({
      service: "nylorun-runtime",
      version: RUNTIME_VERSION,
      protocol: {
        min: HOST_PROTOCOL.min,
        max: HOST_PROTOCOL.max,
        features: [...HOST_PROTOCOL.features],
      },
      tenant: module.tenant(),
      aggregate,
      host: {
        hostId: config.hostId,
        url: options.publicUrl ?? url,
        pid,
      },
    });
  };

  const adminApi = createAdminApi({
    status: adminStatusBody,
    shutdown: () => void close(),
    document: adminDocument,
    operatorKeys: async () => {
      const resolved = await module.resolve();
      return resolved.kind === "open" ? resolved.handle.operatorKeys?.() : undefined;
    },
  });

  const app = createHostApp({
    module,
    logger,
    hostId: config.hostId,
    adminKey: credentials.adminKey,
    coreVersion,
    pid,
    browserAccess: options.browserAccess === true,
    ...(options.readiness ? { readiness: options.readiness } : {}),
    listening: () =>
      Boolean(server?.listening) && (!operator || Boolean(operatorServer?.listening)),
    closing: () => closing,
    admin: async (request, node) => await adminApi.fetch(request, node),
  });

  /** Where a listener's requests go once their `Host` header checks out. */
  const pipeline = (role: ListenerRole) =>
    getRequestListener(
      async (request, node) => alreadySent(await app.fetch(request, { ...node, role } as HostBindings)),
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

  /** The `Host` values a listener accepts. */
  const hostAllowed = (role: ListenerRole, hostHeader: string | undefined) =>
    role === "operator"
      ? isAllowedRequestHost(hostHeader, {
          port: operatorPort,
          host: operator!.host,
          allowNonLoopback: false,
          ...(operator!.allowedHosts ? { allowedHosts: operator!.allowedHosts } : {}),
        })
      : isAllowedRequestHost(hostHeader, {
          port: listenPort,
          host: config.host,
          allowNonLoopback: config.allowNonLoopback,
          ...(containerListen ? { allowedHosts: containerListen.allowedHosts } : {}),
        });

  /** Responses not yet finished; shutdown ends the streams among them. */
  const inFlight = new Set<ServerResponse>();
  const serve = (role: ListenerRole) => {
    const next = pipeline(role);
    return (req: IncomingMessage, res: ServerResponse) => {
      const started = Date.now();
      inFlight.add(res);
      res.once("close", () => inFlight.delete(res));
      // D§11: `Host` first, before anything reads the request.
      if (hostAllowed(role, headerValue(req, "host"))) return void next(req, res);
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
    if (operator && !containerListen && !isLoopbackHost(operator.host))
      throw new HostListenError(
        `Refusing to bind the operator listener on non-loopback host ${operator.host}`,
        EXIT_NON_LOOPBACK,
      );
    server = createServer(serve(mainRole));
    await bindListener(server, bindPort, bindHost);
    const address = server.address();
    listenPort =
      typeof address === "object" && address ? address.port : bindPort;
    url = `http://${bindHost}:${listenPort}`;
    adminUrl = url;
    if (operator) {
      operatorServer = createServer(serve("operator"));
      await bindListener(operatorServer, operator.port, operator.host).catch(async (error) => {
        // Leave nothing half-open: the main listener closes too.
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        throw error;
      });
      const operatorAddress = operatorServer.address();
      operatorPort =
        typeof operatorAddress === "object" && operatorAddress
          ? operatorAddress.port
          : operator.port;
      adminUrl = `http://${operator.host}:${operatorPort}`;
    }
    // The Tenant opens once the listener is bound: `/ready` and `/v1/admin/status` answer
    // while it opens, and say why when it cannot.
    await module.start();
    logger.info("host_listening", {
      hostId: config.hostId,
      url,
      ...(operator ? { adminUrl } : {}),
      pid,
    });
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
      const listeners = [server, operatorServer].filter(
        (listening): listening is Server => listening !== undefined,
      );
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
      operatorServer = undefined;
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
    get adminUrl() {
      return adminUrl;
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

