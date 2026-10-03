import type { AbortReason } from "@nylorun/core/harness-api";

/** Why a run's signal aborted: the reason core gave in `cancel`, or the harness's own. */
export class RunAbort extends Error {
  override readonly name: string = "RunAbort";
  constructor(
    readonly kind: AbortReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The default message of each reason. */
export const ABORT_MESSAGES: Readonly<Record<AbortReason, string>> = {
  cancel: "Turn cancelled",
  shutdown: "The harness is stopping",
  deadline: "The advance ran past its deadline",
  "ownership.lost": "Ownership lost",
};

/**
 * The kind of an aborted signal's reason, or `undefined` while it has not aborted. A reason
 * that is not a `RunAbort` came from outside the run and counts as `shutdown`.
 */
export function runAbortKind(signal: AbortSignal): AbortReason | undefined {
  if (!signal.aborted) return undefined;
  return signal.reason instanceof RunAbort ? signal.reason.kind : "shutdown";
}
