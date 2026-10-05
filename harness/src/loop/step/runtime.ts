import type { ToolRegistry } from "../../definition/registry.js";
import type { ModelAdapter } from "@nylorun/core/define";
import type { InputEvent, TranscriptEntry } from "@nylorun/core/define";
import type { ToolResult } from "@nylorun/core/define";
import type { BoundMiddleware } from "@nylorun/core/define";
import type { JsonValue } from "@nylorun/core/define";

/** Compiled definition pieces plus the per-run model adapter for one step. */
export interface StepRuntime {
  readonly middleware: readonly BoundMiddleware[];
  readonly invoke: ModelAdapter;
  readonly registry: ToolRegistry;
  /** Mutable session memory bag shared with tools. */
  sessionState?: Record<string, JsonValue>;
}

export interface StepInput {
  readonly executionId: string;
  readonly turnId: string;
  readonly stepId: string;
  /** One-based position of this turn within the execution. */
  readonly turnNumber: number;
  /** One-based position of this Model Step within the Turn. */
  readonly stepNumber: number;
  readonly info?: unknown;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
}

/** Internal view consumed by a single model step. */
export interface ExecutionSnapshot {
  readonly id: string;
  readonly status: "running";
  readonly turnCount: number;
  readonly revision: number;
  readonly transcript: readonly TranscriptEntry[];
}
