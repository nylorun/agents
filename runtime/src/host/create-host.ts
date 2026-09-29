import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  checkCompatibility,
  HOST_PROTOCOL,
  isTenantId,
  PROTOCOL_HEADER,
  TENANT_HEADER,
  PUBLISHABLE_KEY_HEADER,
  tenantOfPublishableKey,
} from "@nylorun/core/compatibility";
import { answerPreflight } from "./cors.js";
import {
  AdminStatusSchema,
  CreateTenantRequestSchema,
} from "@nylorun/core/contracts";
import {
  TenantBusyError,
  TenantConflictError,
} from "../tenant/quarantine.js";
import {
  TenantNotFoundError,
  type Logger,
  type TenantModule,
} from "../tenant/types.js";
import type { HostConfigFile, HostCredentialsFile } from "./config.js";
import type { ContainerListen } from "./stack-config.js";
import {
  EXIT_NON_LOOPBACK,
  EXIT_PORT_IN_USE,
  HostListenError,
  isAllowedRequestHost,
  isJsonContentType,
  isLoopbackHost,
  readBearer,
  readJsonBody,
  redactRoutePath,
  requestHasBody,
  sendJson,
  sendOpaqueNotFound,
  sendProtocolRejected,
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
   * Infrastructure readiness (`infra/readiness.ts`). `/ready` adds its checks
   * and answers 503 while it reports not ok. Default: listener and discovery
   * only.
   */
  readiness?: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  /**
   * Shutdown steps around closing the Tenants. `close()` runs them whatever asked for it
   * (SIGTERM in `host/main.ts`, `POST /v1/admin/host/shutdown`): the listener stops, then
   * `beforeTenants` (stop the Worker so no advance starts on a closing Tenant), the Tenants
   * close, then `afterTenants` (end the infrastructure clients). A failing step is logged
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

function hashUtf8(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of SHA-256 digests of the presented and stored admin keys. */
export function adminKeyMatches(
  presented: string | undefined,
  adminKey: string,
): boolean {
  if (presented === undefined) return false;
  const a = hashUtf8(presented);
  const b = hashUtf8(adminKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headerValue(
  headers: IncomingMessage["headers"],
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function parseProtocolVersion(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

function protocolAccepted(raw: string | undefined): boolean {
  const version = parseProtocolVersion(raw);
  if (version === undefined) return false;
  return checkCompatibility({ version, required: [] }, HOST_PROTOCOL).ok;
}

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
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const adminStatusBody = async () => {
    const tenants = await module.list();
    const aggregate = await module.summarize();
    return AdminStatusSchema.parse({
      service: "nylorun-runtime",
      version: RUNTIME_VERSION,
      protocol: {
        min: HOST_PROTOCOL.min,
        max: HOST_PROTOCOL.max,
        features: [...HOST_PROTOCOL.features],
      },
      tenants,
      aggregate,
      host: {
        hostId: config.hostId,
        url: options.publicUrl ?? url,
        pid,
      },
    });
  };

  const requireAdmin = (
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean => {
    const token = readBearer(headerValue(request.headers, "authorization"));
    if (!adminKeyMatches(token, credentials.adminKey)) {
      sendOpaqueNotFound(response);
      return false;
    }
    return true;
  };

  const handleAdmin = async (
    request: IncomingMessage,
    response: ServerResponse,
    urlObj: URL,
    segments: string[],
  ): Promise<void> => {
    const method = request.method ?? "GET";
    // /v1/admin/...
    if (segments[2] === "tenants") {
      if (segments.length === 3 && method === "GET") {
        const tenants = await module.list();
        return sendJson(response, 200, tenants);
      }
      if (segments.length === 3 && method === "POST") {
        const body = CreateTenantRequestSchema.parse(
          await readJsonBody(request),
        );
        try {
          const result = await module.create({
            tenantId: body.tenantId,
            name: body.name,
            principalId: body.principalId,
            credentialHash: body.credentialHash,
            idempotencyKey: body.idempotencyKey,
            ...(body.studioCredentialHash
              ? { studioCredentialHash: body.studioCredentialHash }
              : {}),
            ...(body.derivedPrincipals?.length
              ? { derivedPrincipals: body.derivedPrincipals }
              : {}),
          });
          return sendJson(
            response,
            result.created ? 201 : 200,
            result.envelope,
          );
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (
            error instanceof TenantConflictError ||
            (error as { name?: string }).name === "TenantConflictError" ||
            code === "conflict" ||
            code === "tenant_conflict"
          ) {
            return sendRejected(
              response,
              409,
              "tenant_conflict",
              error instanceof Error ? error.message : "Tenant conflict",
            );
          }
          throw error;
        }
      }
      if (segments.length === 4 && segments[3]) {
        const id = segments[3]!;
        if (method === "GET") {
          const status = await module.status(id);
          if (!status) return sendOpaqueNotFound(response);
          return sendJson(response, 200, status);
        }
        if (method === "DELETE") {
          const activeWork =
            (urlObj.searchParams.get("activeWork") as
              | "refuse"
              | "drain"
              | "cancel"
              | null) ?? "refuse";
          if (
            activeWork !== "refuse" &&
            activeWork !== "drain" &&
            activeWork !== "cancel"
          ) {
            return sendJson(response, 400, {
              status: "rejected",
              code: "invalid_request",
              message: "activeWork must be refuse, drain, or cancel",
            });
          }
          try {
            await module.delete(id, activeWork);
            response.writeHead(204);
            response.end();
            return;
          } catch (error) {
            if (error instanceof TenantNotFoundError)
              return sendOpaqueNotFound(response);
            const code = (error as { code?: string }).code;
            if (
              error instanceof TenantBusyError ||
              (error as { name?: string }).name === "TenantBusyError" ||
              code === "active_work" ||
              code === "conflict"
            ) {
              return sendRejected(
                response,
                409,
                "active_work",
                error instanceof Error ? error.message : "Active work",
              );
            }
            throw error;
          }
        }
      }
    }
    // D12: /v1/admin/status and /v1/admin/host share one handler.
    if (
      (segments[2] === "host" || segments[2] === "status") &&
      segments.length === 3 &&
      method === "GET"
    ) {
      return sendJson(response, 200, await adminStatusBody());
    }
    if (
      segments[2] === "host" &&
      segments.length === 4 &&
      segments[3] === "shutdown" &&
      method === "POST"
    ) {
      sendJson(response, 200, { status: "shutting_down" });
      void close();
      return;
    }
    return sendRejected(response, 404, "not_found", "Route not found");
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const started = Date.now();
    let tenantId: string | undefined;
    let statusCode = 500;
    try {
      const urlObj = new URL(request.url ?? "/", "http://runtime.local");
      const pathname = urlObj.pathname;

      // D§11: Host, Origin, then Content-Type — before any other processing.
      const hostHeader = headerValue(request.headers, "host");
      if (
        !isAllowedRequestHost(hostHeader, {
          port: listenPort,
          host: config.host,
          allowNonLoopback: config.allowNonLoopback,
          ...(containerListen
            ? { allowedHosts: containerListen.allowedHosts }
            : {}),
        })
      ) {
        sendRejected(
          response,
          421,
          "host_rejected",
          "Host header is not an allowed loopback or configured address",
        );
        statusCode = 421;
        return;
      }

      const origin = headerValue(request.headers, "origin");
      if (origin !== undefined) {
        const route = pathname.split("/").filter(Boolean);
        // Only Tenant routes, and only when the operator allows browsers; the Tenant then
        // checks the publishable key and its origins before adding any CORS header.
        const tenantRoute = route[0] === "v1" && route[1] !== "admin";
        if (!options.browserAccess || !tenantRoute) {
          sendRejected(
            response,
            403,
            "origin_rejected",
            "Browser Origin headers are not accepted",
          );
          statusCode = 403;
          return;
        }
        if (request.method === "OPTIONS") {
          statusCode = answerPreflight(request, response, route);
          return;
        }
      }

      if (
        requestHasBody(request) &&
        !isJsonContentType(headerValue(request.headers, "content-type"))
      ) {
        sendRejected(
          response,
          415,
          "unsupported_media_type",
          "Request bodies must use application/json",
        );
        statusCode = 415;
        return;
      }

      if (pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "nylorun-runtime",
          version: RUNTIME_VERSION,
          protocol: {
            min: HOST_PROTOCOL.min,
            max: HOST_PROTOCOL.max,
            features: [...HOST_PROTOCOL.features],
          },
          coreVersion,
          hostId: config.hostId,
          pid,
        });
        statusCode = 200;
        return;
      }

      if (pathname === "/ready") {
        const listener = Boolean(server?.listening);
        const discovery = module.started;
        const infra = await options.readiness?.();
        const ready = listener && discovery && !closing && (infra?.ok ?? true);
        sendJson(
          response,
          ready ? 200 : 503,
          {
            status: ready ? "ready" : "not_ready",
            service: "nylorun-runtime",
            checks: { listener, discovery, ...infra?.checks },
          },
        );
        statusCode = ready ? 200 : 503;
        return;
      }

      const segments = pathname.split("/").filter(Boolean);
      const isAdmin =
        segments[0] === "v1" && segments[1] === "admin";

      if (isAdmin) {
        const protocolHeader = headerValue(request.headers, PROTOCOL_HEADER);
        if (!protocolAccepted(protocolHeader)) {
          sendProtocolRejected(response);
          statusCode = 426;
          return;
        }
        if (!requireAdmin(request, response)) {
          statusCode = 404;
          return;
        }
        await handleAdmin(request, response, urlObj, segments);
        statusCode = response.statusCode || 200;
        return;
      }

      // Tenant-scoped routes: header pattern → protocol → resolve → Tenant handle. The Tenant
      // is named by `Nylorun-Tenant`, by the publishable key in `Nylorun-Key`, or by both
      // when they agree.
      const invalid = (message: string) => {
        sendJson(response, 400, {
          status: "rejected",
          code: "invalid_request",
          message,
        });
        statusCode = 400;
      };
      const keyHeader = headerValue(request.headers, PUBLISHABLE_KEY_HEADER);
      const keyTenant =
        keyHeader === undefined ? undefined : tenantOfPublishableKey(keyHeader);
      if (keyHeader !== undefined && keyTenant === undefined)
        return invalid(`${PUBLISHABLE_KEY_HEADER} header is malformed`);
      const tenantHeader = headerValue(request.headers, TENANT_HEADER);
      const named =
        tenantHeader === undefined || tenantHeader.trim() === ""
          ? undefined
          : tenantHeader;
      if (named === undefined && keyTenant === undefined)
        return invalid(`${TENANT_HEADER} header is required`);
      if (named !== undefined && !isTenantId(named))
        return invalid(`${TENANT_HEADER} header is malformed`);
      if (named !== undefined && keyTenant !== undefined && named !== keyTenant)
        return invalid(
          `${PUBLISHABLE_KEY_HEADER} and ${TENANT_HEADER} name different Tenants`,
        );
      tenantId = (named ?? keyTenant)!;

      const protocolHeader = headerValue(request.headers, PROTOCOL_HEADER);
      if (!protocolAccepted(protocolHeader)) {
        sendProtocolRejected(response);
        statusCode = 426;
        return;
      }

      const resolution = await module.resolve(tenantId);
      if (resolution.kind !== "open") {
        if (resolution.kind === "quarantined") {
          logger.warn("tenant_quarantined", {
            tenantId,
            code: resolution.quarantine.code,
            repair: resolution.quarantine.repair,
          });
        }
        sendOpaqueNotFound(response);
        statusCode = 404;
        return;
      }

      await resolution.handle.handle(request, response, urlObj);
      statusCode = response.statusCode || 200;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === "number" && status >= 400 && status < 600) {
        sendJson(response, status, {
          status: "rejected",
          code: status === 400 ? "invalid_request" : "request_rejected",
          message: error instanceof Error ? error.message : "Request rejected",
        });
        statusCode = status;
      } else if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        (error as { name: string }).name === "ZodError"
      ) {
        sendJson(response, 400, {
          status: "rejected",
          code: "invalid_request",
          message: "Invalid request body",
        });
        statusCode = 400;
      } else {
        logger.error("request_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          sendJson(response, 500, {
            status: "rejected",
            code: "internal_error",
            message: "Internal error",
          });
        }
        statusCode = 500;
      }
    } finally {
      if (pathnameIsLogged(request.url)) {
        logger.info("request", {
          status: statusCode,
          tenantId,
          durationMs: Date.now() - started,
          path: redactRoutePath(
            new URL(request.url ?? "/", "http://runtime.local").pathname,
          ),
          method: request.method,
        });
      }
    }
  };

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
    server = createServer((req, res) => {
      void handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          reject(
            new HostListenError(
              `Port ${bindPort} on ${bindHost} is already in use`,
              EXIT_PORT_IN_USE,
              error,
            ),
          );
          return;
        }
        reject(error);
      });
      server!.listen(bindPort, bindHost, resolve);
    });
    const address = server.address();
    listenPort =
      typeof address === "object" && address ? address.port : bindPort;
    url = `http://${bindHost}:${listenPort}`;
    await module.start();
    logger.info("host_listening", {
      hostId: config.hostId,
      url,
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
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeIdleConnections?.();
        });
        server = undefined;
      }
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

function pathnameIsLogged(rawUrl: string | undefined): boolean {
  if (!rawUrl) return true;
  const pathname = new URL(rawUrl, "http://runtime.local").pathname;
  return pathname !== "/health" && pathname !== "/ready";
}
