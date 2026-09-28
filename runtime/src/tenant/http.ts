/**
 * HTTP plumbing shared by the Tenant route modules: typed rejections, the opaque 404 for
 * unknown credentials (D5), request-body parsing and the client-abort signal.
 *
 * Later waves: stable; the streams seam (Wave 2 / Y) keeps using these helpers.
 */
import type { IncomingMessage } from "node:http";

/** D5 opaque failure for unknown/rejected credentials on Tenant routes. */
export const OPAQUE_NOT_FOUND = {
  status: "rejected" as const,
  code: "not_found" as const,
  message: "Not found",
};

/** A rejection's stable code and details, for the ones a client acts on (default `request_rejected`). */
export interface Rejection {
  readonly code?: string;
  readonly details?: unknown;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rejection: Rejection = {}
  ) {
    super(message);
  }
}

export const fail = (
  status: number,
  message: string,
  rejection?: Rejection
): never => {
  throw new HttpError(status, message, rejection);
};

export class OpaqueAuthError extends Error {
  readonly status = 404;
  readonly body = OPAQUE_NOT_FOUND;
  constructor() {
    super(OPAQUE_NOT_FOUND.message);
    this.name = "OpaqueAuthError";
  }
}

export const failOpaque = (): never => {
  throw new OpaqueAuthError();
};

/** AbortSignal tied to the HTTP request being closed by the client. */
export function requestAborted(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  request.on("close", () => {
    if (!request.complete) controller.abort();
  });
  return controller.signal;
}

/** Read a JSON request body, capped at 1 MiB. */
export async function readBody(request: IncomingMessage): Promise<unknown> {
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) fail(413, "Request too large");
  }
  try {
    return JSON.parse(data);
  } catch {
    return fail(400, "Invalid JSON");
  }
}
