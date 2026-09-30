const errorBrand = Symbol.for("@nylorun/core/HarnessError");
/** Machine-readable error raised by Harness-owned code. */
export type HarnessErrorCode =
  | "execution.invalid-state"
  | "execution.invalid-input"
  | "execution.incompatible"
  | "execution.record-failed"
  | "tool.unregistered"
  | "tool.invalid-binding"
  | "agent.build-failed"
  | "agent.lifecycle-sealed"
  | "context.invalid-item"
  | "context.invalid-item-type"
  | "context.invalid-order"
  | "context.invalid-reason"
  | "context.invalid-slot"
  | "interaction.invalid"
  | "interaction.missing-resume"
  | "interaction.uncorrelated-resume"
  | "input.invalid-content"
  | "output.invalid"
  | "output.invalid-schema"
  | "json.invalid-data"
  | "json.invalid-object"
  | "middleware.next-after-return"
  | "middleware.next-called-twice"
  | "middleware.request-mutators-revoked"
  | "model.candidate-missing"
  | "model.adapter-invalid-options"
  | "model.adapter-invalid-response"
  | "model.invalid-candidate"
  | "model.invalid-directive"
  | "model.unsupported-content"
  | "model.unsupported-output-schema"
  /** A provider failure the model adapter classified (Model Calls §6.1). */
  | `model.${import("./types/model.js").ModelFailureCode}`
  | "configuration.duplicate-tool-name"
  | "configuration.invalid"
  | "configuration.invalid-instructions"
  | "configuration.invalid-order"
  | "configuration.invalid-reason"
  | "configuration.invalid-slot"
  | "configuration.invalid-tools"
  | "configuration.model-selection-conflict"
  | "response.invalid-replacement"
  | "tool.invalid"
  | "tool.invalid-arguments"
  | "tool.invalid-output"
  | "tool.invalid-name"
  | "tool.invalid-schema"
  | "tool.invalid-tool-result";

export type HarnessErrorDetails = Readonly<
  Record<string, string | number | boolean>
>;

export interface HarnessErrorOptions {
  readonly cause?: unknown;
  readonly details?: HarnessErrorDetails;
}

/**
 * The sole error shape produced by Harness itself. Message text is explanatory;
 * callers must branch on `code`.
 */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly details: HarnessErrorDetails;

  constructor(
    code: HarnessErrorCode,
    message: string,
    options: HarnessErrorOptions = {}
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "HarnessError";
    Object.defineProperty(this, errorBrand, { value: true });
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isHarnessError(error: unknown): error is HarnessError {
  return (
    error instanceof HarnessError ||
    (typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[errorBrand] === true)
  );
}
