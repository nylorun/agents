/**
 * One model call's attempts (Model Calls §6): pi-ai's transient errors, plus a stream the provider
 * or a gateway cut before its last chunk, are tried again with pi-ai's backoff, up to the Tenant's
 * `modelAttempts`. Each retry is reported, so a call that needed one is visible in the gate's log.
 */
import {
  isRetryableAssistantError,
  retryDelayMs,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

/**
 * A stream that ended before its terminal chunk: Vercel AI Gateway's `Upstream stream ended before
 * terminal chunk` (its `finish_reason: stream_terminated`) when the provider behind it fails after
 * the stream began. Nothing of the step ran, so it is safe to call again; pi-ai's own list doesn't
 * know this wording.
 */
export const STREAM_CUT =
  /stream ended before (?:its |the |a )?terminal chunk|upstream stream ended|stream[_ ]terminated/i;

/** True for a failed message worth another attempt. */
export function isRetryableModelError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  if (isRetryableAssistantError(message)) return true;
  return STREAM_CUT.test(message.errorMessage ?? "");
}

/** One retry, as `onRetry` hears it: before the delay is waited. */
export interface ModelRetry {
  /** The attempt about to start, the first counted as 1. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  /** The failed attempt's error, as the provider or pi-ai worded it. */
  readonly errorMessage: string;
}

export interface ModelRetryPolicy {
  /** Attempts, the first included. 1 means no retry. */
  readonly attempts: number;
  /** The delay before the second attempt; it doubles each time (pi-ai's `retryDelayMs`). */
  readonly baseDelayMs: number;
}

/**
 * Runs `produce` until it answers, fails in a way no retry changes, or uses up its attempts.
 * An abort is never retried: an aborted message comes back as it is, and an abort during the
 * delay comes back as the last failure marked `aborted`, as pi-ai's `retryAssistantCall` does.
 */
export async function retryModelCall(
  produce: () => Promise<AssistantMessage>,
  policy: ModelRetryPolicy,
  signal: AbortSignal,
  onRetry?: (retry: ModelRetry) => void,
): Promise<AssistantMessage> {
  const maxAttempts = Math.max(1, policy.attempts);
  for (let attempt = 1; ; attempt += 1) {
    const response = await produce();
    if (response.stopReason !== "error") return response;
    if (attempt >= maxAttempts || !isRetryableModelError(response)) return response;
    const delayMs = retryDelayMs({ baseDelayMs: policy.baseDelayMs }, attempt);
    try {
      onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs, errorMessage: response.errorMessage ?? "Unknown error" });
    } catch {
      /* Reporting never changes the call. */
    }
    if (!(await wait(delayMs, signal))) {
      const { errorMessage: _errorMessage, ...rest } = response;
      return { ...rest, stopReason: "aborted" };
    }
  }
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
