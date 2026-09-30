/**
 * The Tenant's typed rejections: what a route or the code it calls throws for the client to
 * see (`api/http/respond.ts` answers it), and the opaque 404 for unknown credentials (D5).
 *
 * Later waves: stable; the streams seam (Wave 2 / Y) keeps using these helpers.
 */

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
