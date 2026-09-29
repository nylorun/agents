/**
 * Browser access at the Host (Host feature `browser-access`). A preflight carries no
 * credentials and no header values, so it cannot name a Tenant: the Host answers it from the
 * route alone, permissively for browser routes, and the Tenant enforces the publishable key's
 * origin allowlist on the actual request (`tenant/browser.ts`). A cached preflight therefore
 * never widens access, and it grants no credentials.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSerializedOrigin } from "@nylorun/core/contracts";

/** Request headers a browser may send to the Runtime. */
export const BROWSER_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "nylorun-key",
  "nylorun-tenant",
  "nylorun-protocol",
  "last-event-id",
] as const;
const BROWSER_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Tenant routes a browser may call: agents (list), sessions (not the sandbox tool route),
 * vaults, AG-UI and the JWKS. Tokens, access management, executors, actions and Tenant
 * settings never are.
 */
export function isBrowserRoute(
  method: string,
  segments: readonly string[]
): boolean {
  const [v1, resource, id, sub] = segments;
  if (v1 !== "v1") return false;
  switch (resource) {
    case "agents":
      return segments.length === 2 && method === "GET";
    case "sessions":
      return !(sub === "sandbox" && id !== undefined);
    case "vaults":
    case "ag-ui":
      return true;
    case "access":
      return segments.length === 3 && id === "jwks" && method === "GET";
    default:
      return false;
  }
}

/** The `Origin` header if it is a serialized origin (not `null`, not a path). */
export function browserOrigin(request: IncomingMessage): string | undefined {
  const raw = request.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  return origin !== undefined && isSerializedOrigin(origin) ? origin : undefined;
}

/**
 * Answers a CORS preflight: `204` with the allowed methods and headers for a browser route,
 * `403` without any CORS header otherwise.
 */
export function answerPreflight(
  request: IncomingMessage,
  response: ServerResponse,
  segments: readonly string[]
): number {
  const origin = browserOrigin(request);
  const method = String(
    request.headers["access-control-request-method"] ?? ""
  ).toUpperCase();
  const requested = String(request.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const allowed =
    origin !== undefined &&
    (BROWSER_METHODS as readonly string[]).includes(method) &&
    isBrowserRoute(method, segments) &&
    requested.every((name) =>
      (BROWSER_REQUEST_HEADERS as readonly string[]).includes(name)
    );
  if (!allowed) {
    response.writeHead(403, { "content-length": "0" });
    response.end();
    return 403;
  }
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": BROWSER_METHODS.join(", "),
    "access-control-allow-headers": requested.join(", "),
    "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    "content-length": "0",
  });
  response.end();
  return 204;
}

/**
 * CORS headers for an actual request from an allowed origin; set once with `setHeader`, so
 * every response that follows (JSON, errors, SSE) carries them.
 */
export function setCorsHeaders(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader(
    "access-control-expose-headers",
    "retry-after, www-authenticate"
  );
  response.setHeader("cache-control", "no-store");
}
