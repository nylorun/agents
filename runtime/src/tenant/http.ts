/**
 * The Tenant's typed rejections: what a route or the code it calls throws for the client to
 * see (`api/http/respond.ts` answers it), and the opaque 404 (D5) for what must not be told
 * apart from nothing: a capability link the Runtime did not sign, a Tenant that is not this
 * Host's. Credentials are `401` with a challenge since protocol 9 (`resource-server.ts`).
 *
 * Later waves: stable; the streams seam (Wave 2 / Y) keeps using these helpers.
 */

/** D5's opaque failure: a 404 that says nothing of why. */
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
