import type { ExecutionEvent } from "../types/execution.js";
import type { ObserveEvent, Observer } from "@nylorun/core/define";
import type { JsonValue } from "@nylorun/core/define";
import { copyJson } from "@nylorun/core/define";

export type ObserveEmit = (event: ObserveEvent | (() => ObserveEvent)) => void;

export type ExecutionOutcomeEvent = {
  type:
    | "execution.completed"
    | "execution.paused"
    | "execution.cancelled"
    | "execution.failed"
    | "observation.failed";
  attributes?: Record<string, JsonValue>;
};

export function createObservationSink(input: {
  readonly listener?: (event: ExecutionEvent) => void | Promise<void>;
  readonly executionId: () => string;
  readonly runId: string;
}): {
  readonly observe: ObserveEmit;
  readonly emit: (event: ObserveEvent | ExecutionOutcomeEvent) => void;
} {
  let sequence = 0;
  let reportingFailure = false;
  const emit = (event: ObserveEvent | ExecutionOutcomeEvent) => {
    if (!input.listener) return;
    const value = copyJson({
      ...event,
      executionId: input.executionId(),
      runId: input.runId,
      sequence: ++sequence,
    }) as ExecutionEvent;
    const failed = () => {
      if (reportingFailure || event.type === "observation.failed") return;
      reportingFailure = true;
      emit({
        type: "observation.failed",
        attributes: { message: "Execution observer failed; execution is continuing" },
      });
      reportingFailure = false;
    };
    try {
      const result = input.listener(value);
      if (result) void Promise.resolve(result).catch(failed);
    } catch {
      failed();
    }
  };
  return {
    emit,
    observe(source) {
      if (!input.listener) return;
      emit(typeof source === "function" ? source() : source);
    },
  };
}

export function emitObserve(
  listener: Observer | undefined,
  event: ObserveEvent | (() => ObserveEvent),
): void {
  if (!listener) return;
  try {
    const result = listener(typeof event === "function" ? event() : event);
    if (result) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Observation is deliberately fail-open for ObserveEvent-only callers.
  }
}
