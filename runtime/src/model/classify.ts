import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  ModelFailureCode,
  ModelFailureOutcome,
} from "@nylorun/core/define";

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;
const QUOTA = /insufficient_quota|quota exceeded|out of budget|billing|usage limit/i;
const OVERLOADED = /overloaded|\b529\b|\b503\b|service.?unavailable|high demand/i;
const TIMEOUT = /timed? out|timeout/i;
const CONTENT_POLICY = /content.?(policy|filter|management)|safety|flagged|moderation/i;
const AUTH =
  /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.?api.?key|incorrect api key|authentication|not configured/i;

/**
 * Classify a failed pi-ai response (`stopReason: "error"`) into a failure outcome
 * (Model Calls §6.1). Context overflow is checked first, with the binding's window so
 * silent overflow is caught too.
 */
export function classifyAssistantError(
  message: AssistantMessage,
  contextWindow?: number,
): ModelFailureOutcome {
  const text = message.errorMessage ?? `Provider stopped: ${message.stopReason}`;
  if (isContextOverflow(message, contextWindow))
    return failure("context_overflow", text, false);
  if (RATE_LIMITED.test(text))
    return failure("rate_limited", text, !QUOTA.test(text));
  if (QUOTA.test(text)) return failure("rate_limited", text, false);
  if (OVERLOADED.test(text)) return failure("overloaded", text, true);
  if (TIMEOUT.test(text)) return failure("timeout", text, true);
  if (CONTENT_POLICY.test(text)) return failure("content_policy", text, false);
  if (AUTH.test(text)) return failure("auth", text, false);
  if (isRetryableAssistantError(message)) return failure("transient", text, true);
  return failure("invalid_request", text, false);
}

/** Classify an error a model provider threw (gateway, fixture, or a setup failure). */
export function classifyThrown(
  error: unknown,
  contextWindow?: number,
): ModelFailureOutcome {
  const text = error instanceof Error ? error.message : String(error);
  return classifyAssistantError(errorMessage(text), contextWindow);
}

export function failure(
  code: ModelFailureCode,
  message: string,
  retryable: boolean,
): ModelFailureOutcome {
  return { kind: "failed", code, message, retryable };
}

/** A pi-ai error message, for classifying failures that did not come from a stream. */
export function errorMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: text,
    timestamp: 0,
  };
}
