import type { JsonObject, JsonValue } from "@nylorun/core/define";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowCheckpoint } from "./checkpoint.js";

/**
 * An interaction the flow itself waits on: a tool node that asked (`ctx.approve`, `ctx.ask`).
 * The tool's resume token stays in its journaled outcome, never here.
 */
export type FlowInteraction = {
  /** The effect of the tool run that asked. */
  readonly invocationId: string;
  /** The tool node's path. */
  readonly path: string;
  readonly toolName: string;
  readonly interaction: {
    readonly id: string;
    readonly kind: "approval" | "response";
    readonly prompt: string;
    readonly metadata?: JsonObject;
  };
  readonly status: "interaction";
};

export type FlowRunResult =
  | { readonly status: "completed"; readonly output: JsonValue }
  | {
      readonly status: "failed";
      readonly error: { readonly code: string; readonly message: string; readonly path?: string };
    }
  | { readonly status: "cancelled" }
  | { readonly status: "paused"; readonly pending: readonly FlowInteraction[] };

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

/**
 * A tool node waits on an interaction. Unwinds like a suspension (siblings keep running), and
 * the flow pauses once nothing else is pending.
 */
export class FlowPause extends HostSuspension {
  constructor(readonly interaction: FlowInteraction) {
    super(interaction.invocationId, "pending");
    this.name = "FlowPause";
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
