import type { ErrorCode } from "@nylorun/core/compatibility";
import { RejectedResponseSchema } from "@nylorun/core/contracts";

export class AdminError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  constructor(
    code: ErrorCode,
    message: string,
    options?: { status?: number; details?: unknown },
  ) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

/** The code of a refusal without the Runtime's rejection body, from its status alone. */
function statusCode(status: number): ErrorCode {
  if (status === 400) return "invalid_request";
  if (status === 401) return "credential_invalid";
  if (status === 404) return "not_found";
  if (status === 415) return "unsupported_media_type";
  if (status >= 500) return "internal_error";
  return "request_rejected";
}

/** The message of Studio's own answers (its server's and proxy's): `{ message }`, with no `code`. */
function studioMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || "code" in body) return undefined;
  const { message } = body as { message?: unknown };
  return typeof message === "string" && message !== "" ? message : undefined;
}

/**
 * The `AdminError` of a refused request: the Runtime's rejection (`{ status: "rejected", code,
 * message }`), else a code from the status with Studio's message, or `what` and the status.
 */
export function rejection(status: number, body: unknown, what: string): AdminError {
  const rejected = RejectedResponseSchema.safeParse(body);
  if (rejected.success)
    return new AdminError(rejected.data.code, rejected.data.message, {
      status,
      details: rejected.data.details,
    });
  return new AdminError(statusCode(status), studioMessage(body) ?? `${what} (${status})`, {
    status,
    details: body,
  });
}
