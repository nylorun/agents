import type { ModelAdapter } from "@nylorun/core/define";
import type { InputEvent, MessageInput, TranscriptEntry } from "@nylorun/core/define";
import type { ObserveEvent } from "@nylorun/core/define";
import type { JsonObject, JsonValue, Tripwire } from "@nylorun/core/define";
import type {
  AgentRef,
  RequiredInteraction,
  ToolExecutionResume,
  ToolOutcome,
  ToolResult,
} from "@nylorun/core/define";

export type ExecutionInput =
  | MessageInput
  | InputEvent
  | { readonly kind: "continue" }
  | {
      readonly kind: "settle";
      readonly invocationId: string;
      readonly outcome: Extract<ToolOutcome, { kind: "completed" | "failed" | "denied" }>;
    }
  | {
      readonly kind: "wait-resolve";
      readonly waitId: string;
      readonly value?: JsonValue;
    };

/** Portable reference to deployed code. Applications must preserve this value intact. */
export interface ToolReference {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly descriptor: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: JsonObject;
    readonly outputSchema?: JsonObject;
  };
}

export interface SavedToolCall {
  readonly callId: string;
  readonly invocationId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly rawArgs: JsonValue;
  readonly reference: ToolReference;
  readonly status: "pending" | "active" | "settled" | "interaction" | "deferred";
  readonly result?: ToolResult;
  readonly interaction?: RequiredInteraction;
  readonly interactionPhase?: "before" | "execute";
  readonly resume?: ToolExecutionResume;
  readonly token?: JsonValue;
  /** Optional wait metadata for H6 durable waits. */
  readonly wait?: {
    readonly kind: "ask" | "approve" | "sleep" | "waitFor";
    readonly waitId: string;
    readonly name?: string;
  };
}

export interface ExecutionPlan {
  readonly turnId: string;
  readonly stepId: string;
  readonly stepNumber: number;
  readonly order: readonly { readonly callId: string; readonly toolName: string }[];
  readonly immediate: readonly ToolResult[];
  readonly calls: readonly SavedToolCall[];
}

/** The turn in flight, kept across a segment rollover or a crash. Cleared when the turn ends. */
export interface TurnState {
  readonly turnId: string;
}

/** Versioned continuation data, not a live execution object. */
export interface ExecutionState {
  readonly version: 1;
  readonly agentId: string;
  /** Definition binding — required for resume after Phase 2. Optional on legacy states. */
  readonly manifestHash?: string;
  readonly executionId: string;
  readonly outputContract?: JsonObject;
  readonly revision: number;
  readonly turnCount: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly status: "ready" | "active" | "completed" | "paused" | "cancelled" | "failed";
  readonly plan?: ExecutionPlan;
  /** Abandoned actions retained for reconciliation, never automatically dispatched. */
  readonly cancelledCalls?: readonly SavedToolCall[];
  /** The current turn; present only while a turn continues in a later segment. */
  readonly turn?: TurnState;
  /**
   * Durable session memory (tools write via `ctx.state`).
   * Runtime persists this with the checkpoint.
   */
  readonly state?: JsonObject;
}

export type ExecutionEvent = (
  | ObserveEvent
  | {
      readonly type:
        | "execution.completed"
        | "execution.paused"
        | "execution.cancelled"
        | "execution.failed"
        | "observation.failed";
      readonly attributes?: JsonObject;
    }
) & {
  readonly executionId: string;
  readonly sequence: number;
  readonly runId: string;
  /** Set on events forwarded from an agent used as a tool. */
  readonly agent?: AgentRef;
};

export interface RunOptions<Info = unknown> {
  readonly state?: ExecutionState;
  readonly input: ExecutionInput;
  readonly onModelCall: ModelAdapter;
  readonly info?: Info;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;
  readonly record?: (state: ExecutionState) => void | Promise<void>;
}

export type RunResult<Output = string> =
  | { readonly status: "completed"; readonly state: ExecutionState; readonly output: Output }
  | {
      readonly status: "paused";
      readonly state: ExecutionState;
      readonly pending: readonly SavedToolCall[];
    }
  | { readonly status: "cancelled"; readonly state: ExecutionState }
  | { readonly status: "failed"; readonly state: ExecutionState; readonly error: Tripwire }
  /**
   * A durable segment ended at a step boundary so the turn continues in a new segment
   * (Model Calls §10). The state is mid-turn; resume it with `{ kind: "continue" }`.
   */
  | { readonly status: "yielded"; readonly state: ExecutionState };
