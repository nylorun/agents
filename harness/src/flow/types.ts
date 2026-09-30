import type { JsonValue } from "@nylorun/core/define";
import type { FlowCheckpoint } from "./checkpoint.js";

export type FlowRunResult =
  | { readonly status: "completed"; readonly output: JsonValue }
  | {
      readonly status: "failed";
      readonly error: { readonly code: string; readonly message: string; readonly path?: string };
    }
  | { readonly status: "cancelled" }
  | { readonly status: "paused"; readonly pending: unknown };

export type FlowDurableResult =
  | {
      readonly status: "waiting" | "uncertain";
      readonly checkpoint: FlowCheckpoint;
      readonly effectIds: readonly string[];
    }
  | {
      readonly status: "completed" | "paused" | "cancelled";
      readonly checkpoint: FlowCheckpoint;
      readonly result: FlowRunResult;
    }
  | {
      readonly status: "failed";
      readonly checkpoint: FlowCheckpoint;
      readonly result: FlowRunResult;
      /** Pending sibling effect ids to cancel after Parallel/Map fail-fast. */
      readonly cancelEffectIds?: readonly string[];
    };

export type FlowFailure = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

/** Thrown when a node fails; unwinds to the engine root. */
export class FlowNodeError extends Error {
  constructor(readonly failure: FlowFailure) {
    super(failure.message);
    this.name = "FlowNodeError";
  }
}

/** Completed effect value that encodes a curated failure (Action endpoint / agent settle). */
export function failedValueOf(value: unknown): FlowFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "failed" || typeof record.code !== "string") return undefined;
  return {
    code: record.code,
    message: typeof record.message === "string" ? record.message : record.code,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
  };
}
