import type { HarnessErrorCode } from "./messages.js";

/** An error a request answers with; the code crosses the wire, the message too. */
export class HarnessApiError extends Error {
  override readonly name = "HarnessApiError";
  constructor(
    readonly code: HarnessErrorCode,
    message: string
  ) {
    super(message);
  }
}
