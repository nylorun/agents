/**
 * The Host's request pipeline as a Hono app, in the order clients depend on: the request log
 * around everything, then Origin and `OPTIONS`, Content-Type, `/health`, `/ready`, and Tenant
 * routes, which go to the Host's one Tenant once the request's headers and protocol check out
 * (`/v1/admin/*` too, since the Admin API is gone). Nothing in a request selects the Tenant
 * (protocol 5); a protocol 4 client's `Nylorun-Tenant` naming another Tenant gets the opaque
 * 404, so a client pointed at the wrong installation fails loudly.
 *
 * Browsers (protocol 7): the Runtime sends no CORS headers; the operator's proxy answers
 * preflights and adds them. A request with `Origin` reaches the Tenant routes, where only a
 * trusted issuer's token is accepted from a browser (`tenant/auth.ts`). `/health` and `/ready`
 * refuse `Origin`. An `OPTIONS` request (a preflight that passed the proxy, or none) is `204`
 * with `Allow` and no CORS header, so a browser that reaches the Runtime directly fails its
 * preflight.
 *
 * The `Host` header is checked before this, in the Node listener (`create-host.ts`):
 * `@hono/node-server` builds the request URL from it, and refuses a malformed one itself.
 * For the same reason paths here come from the Node request, never from the URL's host part.
 */
import type { IncomingMessage } from "node:http";
import { Hono, type Context } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import {
  checkCompatibility,
  HOST_PROTOCOL,
  PROTOCOL_HEADER,
  TENANT_HEADER,
  type ErrorCode,
} from "@nylorun/core/compatibility";
import type { Logger, NodeBindings, TenantModule } from "../tenant/types.js";
import { RUNTIME_VERSION } from "../version.js";
import { findTenantRoute } from "../api/http/app.js";
import { tenantDocument } from "../api/openapi.js";
import {
  headerValue,
  isJsonContentType,
  jsonResponse,
  opaqueNotFoundResponse,
  protocolRejectedResponse,
  pathnameIsLogged,
  redactRoutePath,
  rejectedResponse,
  requestHasBody,
} from "./http.js";

export type HostEnv = {
  Bindings: NodeBindings;
  Variables: {
    /** The Tenant a request reached, for the request log. */
    tenantId?: string;
    /** The status to log when it is not the answer's (a rejection after a stream started). */
    status?: number;
  };
};

export interface HostAppOptions {
  module: TenantModule;
  logger: Logger;
  hostId: string;
  coreVersion: string;
  pid: number;
  readiness?: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  /** The listener is listening. */
  listening(): boolean;
  closing(): boolean;
}

export function createHostApp(options: HostAppOptions): Hono<HostEnv> {
  const { module, logger } = options;
  const app = new Hono<HostEnv>();

  app.use(async (c, next) => {
    const started = Date.now();
    try {
      await next();
    } finally {
      const { incoming } = c.env;
      if (pathnameIsLogged(incoming.url))
        logger.info("request", {
          status: statusOf(c),
          tenantId: c.get("tenantId"),
          durationMs: Date.now() - started,
          path: redactRoutePath(pathnameOf(incoming)),
          method: incoming.method,
        });
    }
  });

  app.use(async (c, next) => {
    const { incoming } = c.env;
    if (headerValue(incoming, "origin") !== undefined) {
      // Only Tenant routes; the Tenant then accepts only a trusted issuer's token from a
      // browser.
      if (pathnameOf(incoming).split("/").filter(Boolean)[0] !== "v1")
        return rejectedResponse(
          403,
          "origin_rejected",
          "Browser Origin headers are not accepted",
        );
    }
    // CORS is the operator's proxy's: an OPTIONS request gets no CORS header.
    if (incoming.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { allow: ALLOWED_METHODS } });
    await next();
  });

  app.use(async (c, next) => {
    const { incoming } = c.env;
    if (
      requestHasBody(incoming) &&
      !isJsonContentType(headerValue(incoming, "content-type")) &&
      // An artifact upload's body is the file itself, of any type.
      tenantRouteOf(incoming)?.bytes !== true
    )
      return rejectedResponse(
        415,
        "unsupported_media_type",
        "Request bodies must use application/json",
      );
    await next();
  });

  app.all("*", async (c) => {
    const { incoming, outgoing } = c.env;
    const url = new URL(incoming.url ?? "/", "http://runtime.local");
    const pathname = url.pathname;

    if (pathname === "/health")
      return jsonResponse(200, {
        status: "ok",
        service: "nylorun-runtime",
        version: RUNTIME_VERSION,
        protocol: {
          min: HOST_PROTOCOL.min,
          max: HOST_PROTOCOL.max,
          features: [...HOST_PROTOCOL.features],
        },
        coreVersion: options.coreVersion,
        hostId: options.hostId,
        pid: options.pid,
      });

    if (pathname === "/ready") {
      const listener = options.listening();
      const tenant = module.ready;
      const infra = await options.readiness?.();
      const ready = listener && tenant && !options.closing() && (infra?.ok ?? true);
      const harness = module.harnessStatus();
      return jsonResponse(ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
        service: "nylorun-runtime",
        checks: { listener, tenant, ...infra?.checks },
        ...(harness ? { harness: { mode: harness.mode, connected: harness.connected } } : {}),
      });
    }

    // This API's own description: public, as the npm package that ships it.
    if (pathname === "/openapi.json" && incoming.method === "GET")
      return jsonResponse(200, tenantDocument(), { "cache-control": "no-cache" });

    // Tenant routes: protocol → the Tenant → selection → the Tenant's routes.
    const tenantHeader = headerValue(incoming, TENANT_HEADER);
    const named =
      tenantHeader === undefined || tenantHeader.trim() === "" ? undefined : tenantHeader.trim();

    const protocol = headerValue(incoming, PROTOCOL_HEADER);
    // A capability link is opened without the header; when one is sent, it is checked.
    if (
      !protocolAccepted(protocol) &&
      !(protocol === undefined && tenantRouteOf(incoming)?.unversioned === true)
    )
      return protocolRejectedResponse();

    const resolution = await module.resolve();
    if (resolution.kind !== "open") {
      if (resolution.cause)
        logger.warn("tenant_unavailable", {
          code: resolution.cause.code,
          repair: resolution.cause.repair,
        });
      return opaqueNotFoundResponse();
    }
    const { handle } = resolution;
    const tenantId = handle.envelope.id;
    // A protocol 4 client names the Tenant: naming another reached the wrong installation.
    if (named !== undefined && named !== tenantId) return opaqueNotFoundResponse();
    c.set("tenantId", tenantId);
    return await handle.fetch(c.req.raw, { incoming, outgoing });
  });

  app.onError((error, c) => {
    const status = (error as { status?: number }).status;
    let rejection: { status: number; code: ErrorCode; message: string };
    if (typeof status === "number" && status >= 400 && status < 600) {
      rejection = {
        status,
        code: status === 400 ? "invalid_request" : "request_rejected",
        message: error.message,
      };
    } else if (error.name === "ZodError") {
      rejection = { status: 400, code: "invalid_request", message: "Invalid request body" };
    } else {
      logger.error("request_failed", { error: error.message });
      rejection = { status: 500, code: "internal_error", message: "Internal error" };
    }
    c.set("status", rejection.status);
    const { outgoing } = c.env;
    // Once a response has started, the rejection can only end it.
    if (outgoing.headersSent) {
      outgoing.end();
      return RESPONSE_ALREADY_SENT;
    }
    return rejectedResponse(rejection.status, rejection.code, rejection.message);
  });

  return app;
}

/** The methods the Runtime serves, for an `OPTIONS` answer's `Allow`. */
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

/** The Tenant route a request names, if any; a malformed path names none. */
function tenantRouteOf(incoming: IncomingMessage) {
  const segments: string[] = [];
  for (const segment of pathnameOf(incoming).split("/").filter(Boolean)) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  if (segments[0] !== "v1") return undefined;
  return findTenantRoute(incoming.method ?? "GET", segments);
}

/** The answer's status: a Response's, or the Node response's when it was written there. */
function statusOf(c: Context<HostEnv>): number {
  const logged = c.get("status");
  if (logged !== undefined) return logged;
  if (c.res.headers.has(ALREADY_SENT)) return c.env.outgoing.statusCode || 200;
  return c.res.status;
}

const ALREADY_SENT = "x-hono-already-sent";

function pathnameOf(incoming: IncomingMessage): string {
  return new URL(incoming.url ?? "/", "http://runtime.local").pathname;
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
