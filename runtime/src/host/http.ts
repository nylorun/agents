import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../api/http/respond.js";
import {
  HOST_PROTOCOL,
  type ErrorCode,
  type ProtocolRange,
} from "@nylorun/core/compatibility";

export const OPAQUE_NOT_FOUND = {
  status: "rejected" as const,
  code: "not_found" as const,
  message: "Not found",
};

export const EXIT_PORT_IN_USE = 98;
export const EXIT_NON_LOOPBACK = 99;

export class HostListenError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HostListenError";
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  // No Access-Control-* headers (D§11).
  response.writeHead(status, jsonHeaders(payload));
  response.end(payload);
}

/** `sendJson` as a Response, byte for byte (with any extra headers): the Host's answers. */
export { jsonResponse };

function jsonHeaders(payload: string) {
  return {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  };
}

function rejection(code: ErrorCode, message: string, details?: unknown) {
  const body: {
    status: "rejected";
    code: ErrorCode;
    message: string;
    details?: unknown;
  } = { status: "rejected", code, message };
  if (details !== undefined) body.details = details;
  return body;
}

function protocolRejection(protocol: ProtocolRange) {
  return {
    status: "rejected",
    code: "protocol_unsupported",
    protocol: {
      min: protocol.min,
      max: protocol.max,
      features: [...protocol.features],
    },
  };
}

export function sendRejected(
  response: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): void {
  sendJson(response, status, rejection(code, message, details));
}

export function rejectedResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  return jsonResponse(status, rejection(code, message, details));
}

export function sendOpaqueNotFound(response: ServerResponse): void {
  sendJson(response, 404, OPAQUE_NOT_FOUND);
}

export function opaqueNotFoundResponse(): Response {
  return jsonResponse(404, OPAQUE_NOT_FOUND);
}

export function protocolRejectedResponse(
  protocol: ProtocolRange = HOST_PROTOCOL,
): Response {
  return jsonResponse(426, protocolRejection(protocol));
}

/**
 * D§11 Host allowlist: loopback forms with the listening port, plus the
 * configured host when `allowNonLoopback` is set.
 *
 * An explicit `allowedHosts` list (container mode) replaces that rule: only
 * those exact `name:port` values are accepted.
 */
export function isAllowedRequestHost(
  hostHeader: string | undefined,
  options: {
    port: number;
    host: string;
    allowNonLoopback?: boolean;
    allowedHosts?: readonly string[];
  },
): boolean {
  if (hostHeader === undefined) return false;
  const normalized = hostHeader.trim().toLowerCase();
  if (options.allowedHosts !== undefined) {
    return options.allowedHosts.some(
      (entry) => entry.trim().toLowerCase() === normalized,
    );
  }
  const port = String(options.port);
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (options.allowNonLoopback) {
    const configured = options.host.trim().toLowerCase();
    if (configured.includes(":") && !configured.startsWith("[")) {
      allowed.add(`[${configured}]:${port}`);
    } else {
      allowed.add(`${configured}:${port}`);
    }
  }
  return allowed.has(normalized);
}

export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const media = value.split(";")[0]!.trim().toLowerCase();
  return media === "application/json";
}

/** True when the request carries a body (Content-Length > 0 or chunked). */
export function requestHasBody(request: IncomingMessage): boolean {
  const te = request.headers["transfer-encoding"];
  const transfer = Array.isArray(te) ? te.join(",") : te;
  if (transfer && transfer.toLowerCase() !== "identity") return true;
  const cl = request.headers["content-length"];
  const raw = Array.isArray(cl) ? cl[0] : cl;
  if (raw === undefined) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

/** `/health` and `/ready` are polled; the request log leaves them out. */
export function pathnameIsLogged(rawUrl: string | undefined): boolean {
  if (!rawUrl) return true;
  const pathname = new URL(rawUrl, "http://runtime.local").pathname;
  return pathname !== "/health" && pathname !== "/ready";
}

/** Redact path parameters after `/v1/sessions/` for Host logs. */
export function redactRoutePath(pathname: string): string {
  const parts = pathname.split("/");
  // ["", "v1", "sessions", "<id>", ...]
  if (parts[1] === "v1" && parts[2] === "sessions" && parts.length > 3) {
    return `/v1/sessions/:id${parts.length > 4 ? "/…" : ""}`;
  }
  return pathname;
}

/** Constant-time comparison of SHA-256 digests of the presented and stored admin keys. */
export function adminKeyMatches(presented: string | undefined, adminKey: string): boolean {
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(adminKey, "utf8").digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A request header's first value. */
export function headerValue(incoming: IncomingMessage, name: string): string | undefined {
  const raw = incoming.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function readBearer(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  return match?.[1];
}

/** A JSON request body, capped at `limit` bytes (413); `undefined` when there is none. */
export async function readJsonBody(request: Request, limit = 1024 * 1024): Promise<unknown> {
  if (request.body === null) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error("Request too large"), { status: 413 });
    }
    chunks.push(value);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}
