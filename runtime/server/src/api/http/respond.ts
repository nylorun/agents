/**
 * How the Tenant API answers: JSON with an explicit length, and the one mapping from what a
 * route throws to the rejection a client sees. The Hono routes and the router they replace
 * (`routes.ts`) both answer through here, so a route answers the same wherever it runs.
 */
import { SandboxRouteError } from "../../core/sandbox-routes.js";
import { HttpError, OpaqueAuthError } from "../../tenant/http.js";
import { VaultError } from "../../vault/error.js";

/** A JSON answer. CORS headers a browser needs are already on the Node response. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      ...headers,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
  });
}

export interface Rejection {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/** What a Tenant route that threw `error` answers. */
export function rejectionOf(error: unknown): Rejection {
  if (error instanceof OpaqueAuthError)
    return { status: error.status, body: error.body, headers: {} };
  const status =
    error instanceof HttpError ||
    error instanceof VaultError ||
    error instanceof SandboxRouteError
      ? error.status
      : (error as { name?: string } | undefined)?.name === "ZodError" ||
          (error as Error | undefined)?.message === "Invalid cursor"
        ? 400
        : 500;
  const rejection = error instanceof HttpError ? error.rejection : {};
  return {
    status,
    body: {
      status: "rejected",
      code: status === 500 ? "internal_error" : (rejection.code ?? "request_rejected"),
      message: status === 500 ? "Runtime request failed" : (error as Error).message,
      ...(rejection.details === undefined ? {} : { details: rejection.details }),
    },
    headers: error instanceof HttpError ? error.headers : {},
  };
}
