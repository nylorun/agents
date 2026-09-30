/**
 * The Host's request pipeline as a Hono app, in the order clients depend on: the request log
 * around everything, then Origin (and browser preflights), Content-Type, `/health`, `/ready`,
 * the Admin API, and Tenant routes, which go to the Tenant named by the request once its
 * headers and protocol check out.
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
  isTenantId,
  PROTOCOL_HEADER,
  PUBLISHABLE_KEY_HEADER,
  TENANT_HEADER,
  tenantOfPublishableKey,
  type ErrorCode,
} from "@nylorun/core/compatibility";
import type { Logger, NodeBindings, TenantModule } from "../tenant/types.js";
import { RUNTIME_VERSION } from "../version.js";
import { findTenantRoute } from "../api/http/app.js";
import { tenantDocument } from "../api/openapi.js";
import { answerPreflight } from "./cors.js";
import {
  adminKeyMatches,
  headerValue,
  isJsonContentType,
  jsonResponse,
  opaqueNotFoundResponse,
  protocolRejectedResponse,
  readBearer,
  pathnameIsLogged,
  redactRoutePath,
  rejectedResponse,
  requestHasBody,
} from "./http.js";
import type { ListenerRole } from "./create-host.js";

export type HostBindings = NodeBindings & { readonly role: ListenerRole };
export type HostEnv = {
  Bindings: HostBindings;
  Variables: {
    /** The Tenant a request named, for the request log. */
    tenantId?: string;
    /** The status to log when it is not the answer's (a rejection after a stream started). */
    status?: number;
  };
};

export interface HostAppOptions {
  module: TenantModule;
  logger: Logger;
  hostId: string;
  adminKey: string;
  coreVersion: string;
  pid: number;
  browserAccess: boolean;
  readiness?: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  /** Every listener is listening. */
  listening(): boolean;
  closing(): boolean;
  /** The Admin API (`admin-api.ts`), for a request whose admin key checked out. */
  admin(request: Request, node: NodeBindings): Promise<Response>;
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
    const { incoming, outgoing, role } = c.env;
    if (headerValue(incoming, "origin") !== undefined) {
      const route = pathnameOf(incoming).split("/").filter(Boolean);
      // Only Tenant routes, and only when the operator allows browsers; the Tenant then
      // checks the publishable key and its origins before adding any CORS header.
      const tenantRoute = route[0] === "v1" && route[1] !== "admin";
      // The operator listener never serves browsers.
      if (!options.browserAccess || role === "operator" || !tenantRoute)
        return rejectedResponse(
          403,
          "origin_rejected",
          "Browser Origin headers are not accepted",
        );
      if (incoming.method === "OPTIONS") {
        c.set("status", answerPreflight(incoming, outgoing, route, browserRoute));
        return RESPONSE_ALREADY_SENT;
      }
    }
    await next();
  });

  app.use(async (c, next) => {
    const { incoming } = c.env;
    if (requestHasBody(incoming) && !isJsonContentType(headerValue(incoming, "content-type")))
      return rejectedResponse(
        415,
        "unsupported_media_type",
        "Request bodies must use application/json",
      );
    await next();
  });

  app.all("*", async (c) => {
    const { incoming, outgoing, role } = c.env;
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
      const discovery = module.started;
      const infra = await options.readiness?.();
      const ready = listener && discovery && !options.closing() && (infra?.ok ?? true);
      return jsonResponse(ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
        service: "nylorun-runtime",
        checks: { listener, discovery, ...infra?.checks },
      });
    }

    // This API's own description: public, as the npm package that ships it.
    if (pathname === "/openapi.json" && incoming.method === "GET")
      return jsonResponse(200, tenantDocument(), { "cache-control": "no-cache" });

    const segments = pathname.split("/").filter(Boolean);
    if (segments[0] === "v1" && segments[1] === "admin") {
      // A public listener has no admin routes: the same 404 as a wrong admin key.
      if (role === "public") return opaqueNotFoundResponse();
      if (!protocolAccepted(headerValue(incoming, PROTOCOL_HEADER)))
        return protocolRejectedResponse();
      const token = readBearer(headerValue(incoming, "authorization"));
      if (!adminKeyMatches(token, options.adminKey)) return opaqueNotFoundResponse();
      return await options.admin(c.req.raw, { incoming, outgoing });
    }

    // Tenant routes: header pattern → protocol → resolve → the Tenant. The Tenant is named by
    // `Nylorun-Tenant`, by the publishable key in `Nylorun-Key`, or by both when they agree.
    const invalid = (message: string) => rejectedResponse(400, "invalid_request", message);
    const keyHeader = headerValue(incoming, PUBLISHABLE_KEY_HEADER);
    const keyTenant =
      keyHeader === undefined ? undefined : tenantOfPublishableKey(keyHeader);
    if (keyHeader !== undefined && keyTenant === undefined)
      return invalid(`${PUBLISHABLE_KEY_HEADER} header is malformed`);
    const tenantHeader = headerValue(incoming, TENANT_HEADER);
    const named =
      tenantHeader === undefined || tenantHeader.trim() === "" ? undefined : tenantHeader;
    if (named === undefined && keyTenant === undefined)
      return invalid(`${TENANT_HEADER} header is required`);
    if (named !== undefined && !isTenantId(named))
      return invalid(`${TENANT_HEADER} header is malformed`);
    if (named !== undefined && keyTenant !== undefined && named !== keyTenant)
      return invalid(`${PUBLISHABLE_KEY_HEADER} and ${TENANT_HEADER} name different Tenants`);
    const tenantId = (named ?? keyTenant)!;
    c.set("tenantId", tenantId);

    if (!protocolAccepted(headerValue(incoming, PROTOCOL_HEADER)))
      return protocolRejectedResponse();

    const resolution = await module.resolve(tenantId);
    if (resolution.kind !== "open") {
      if (resolution.kind === "quarantined")
        logger.warn("tenant_quarantined", {
          tenantId,
          code: resolution.quarantine.code,
          repair: resolution.quarantine.repair,
        });
      return opaqueNotFoundResponse();
    }
    return await resolution.handle.fetch(c.req.raw, { incoming, outgoing });
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

/** A route a browser page may call, decided from the route alone (`api/http/define.ts`). */
function browserRoute(method: string, segments: readonly string[]): boolean {
  return findTenantRoute(method, segments)?.browser === true;
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
