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

/**
 * The `AdminError` of a refused request: the Runtime's rejection (`{ status: "rejected", code,
 * message }`), else `not_found` naming `what` and the status.
 */
export function rejection(status: number, body: unknown, what: string): AdminError {
  const rejected = RejectedResponseSchema.safeParse(body);
  return rejected.success
    ? new AdminError(rejected.data.code, rejected.data.message, {
        status,
        details: rejected.data.details,
      })
    : new AdminError("not_found", `${what} (${status})`, { status, details: body });
}
