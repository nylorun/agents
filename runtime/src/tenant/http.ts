/**
 * HTTP plumbing shared by the Tenant route modules: typed rejections, the opaque 404 for
 * unknown credentials (D5), request-body parsing and the client-abort signal.
 *
 * Later waves: stable; the streams seam (Wave 2 / Y) keeps using these helpers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

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
    readonly rejection: Rejection = {},
    /** Response headers the rejection carries, such as `retry-after` or `www-authenticate`. */
    readonly headers: Readonly<Record<string, string>> = {}
  ) {
    super(message);
  }
}

export const fail = (
  status: number,
  message: string,
  rejection?: Rejection,
  headers?: Readonly<Record<string, string>>
): never => {
  throw new HttpError(status, message, rejection, headers);
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

/**
 * AbortSignal that aborts when the client goes away before the response is finished. The
 * request's own `close` cannot tell: it fires as soon as its body has been read.
 */
export function requestAborted(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  return controller.signal;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Read a request body as UTF-8 text, capped at 1 MiB. */
export async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) fail(413, "Request too large");
    chunks.push(chunk);
  }
  // Decoded once, so a character split across chunks stays whole.
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a JSON request body, capped at 1 MiB. */
export async function readBody(request: IncomingMessage): Promise<unknown> {
  const data = await readText(request);
  try {
    return JSON.parse(data);
  } catch {
    return fail(400, "Invalid JSON");
  }
}
