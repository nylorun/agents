import type { ModelFailureCode, ModelFailureOutcome } from "../types/model.js";

export const MODEL_FAILURE_CODES: readonly ModelFailureCode[] = Object.freeze([
  "context_overflow",
  "rate_limited",
  "overloaded",
  "timeout",
  "transient",
  "content_policy",
  "auth",
  "invalid_request",
  "invalid_output",
]);

/** True for a model adapter's failure outcome (`{ kind: "failed", code, message, retryable }`). */
export function isModelFailureOutcome(value: unknown): value is ModelFailureOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  return (
    outcome.kind === "failed" &&
    typeof outcome.code === "string" &&
    (MODEL_FAILURE_CODES as readonly string[]).includes(outcome.code) &&
    typeof outcome.message === "string" &&
    typeof outcome.retryable === "boolean"
  );
}
