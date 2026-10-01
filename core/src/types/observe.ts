import type {
  ContextSnapshot,
  ModelCandidate,
  ModelCall,
  ModelConfigurationSnapshot,
} from "./model.js";
import type { JsonObject, JsonValue } from "./shared.js";
import type { InputEvent, TranscriptEntry } from "./transcript.js";
import type {
  AgentRef,
  RequiredInteraction,
  ToolDescriptor,
  ToolResult,
} from "./tool.js";

/** Curated failure carried on workflow `node.failed` and `turn.failed`. */
export interface WorkflowErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/**
 * LiveEvent payloads for workflow sessions (`workflows.md` §11, `loops.md` §4.6).
 *
 * @deprecated Use the event catalog (`EVENT_CATALOG`, `SessionEventOf<"node.agent">` in
 * `@nylorun/core/contracts`): it types the events the Runtime writes. `node.completed`,
 * `node.failed`, `switch.selected`, `map.items` and `loop.waiting` are not written.
 */
export type WorkflowLiveEventPayload =
  | {
      readonly type: "node.started";
      readonly path: string;
      readonly kind: string;
      readonly key: string;
      readonly iterations?: string;
    }
  | {
      readonly type: "node.completed";
      readonly path: string;
      readonly iterations?: string;
    }
  | {
      readonly type: "node.failed";
      readonly path: string;
      readonly iterations?: string;
      readonly error: WorkflowErrorPayload;
    }
  | {
      readonly type: "node.agent";
      readonly path: string;
      readonly iterations?: string;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "switch.selected";
      readonly path: string;
      readonly case: string;
    }
  | {
      readonly type: "map.items";
      readonly path: string;
      readonly count: number;
    }
  | {
      readonly type: "loop.iteration";
      readonly path: string;
      readonly n: number;
      readonly sessionId?: string;
      readonly turnId?: string;
      readonly manifestHash?: string;
    }
  | {
      readonly type: "loop.waiting";
      readonly path: string;
      readonly n: number;
      readonly sessionId: string;
      readonly interactions: readonly RequiredInteraction[];
    }
  | {
      readonly type: "loop.verified";
      readonly path: string;
      readonly n: number;
      readonly pass: boolean;
      readonly feedback?: string;
      readonly data?: JsonValue;
      readonly verifierSessionId?: string;
    }
  | {
      readonly type: "loop.decided";
      readonly path: string;
      readonly n: number;
      readonly next: "input" | "output";
      readonly patched: boolean;
    };

export type ObserveToolSnapshot = ToolDescriptor;

/** JSON-only model-configuration view suitable for an observation stream. */
export interface ObserveModelConfigurationSnapshot
  extends Omit<ModelConfigurationSnapshot, "tools"> {
  readonly tools: readonly ObserveToolSnapshot[];
}

export interface ObserveSealedCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly invocationId: string;
  readonly owner: { readonly middlewareId: string; readonly slot: string };
  readonly interaction?: RequiredInteraction;
}

export interface ObserveModelRequested {
  /** The exact immutable logical input supplied to the ModelAdapter. */
  readonly call: ModelCall;
  /** Canonical configuration facts and attribution. */
  readonly configuration: ObserveModelConfigurationSnapshot;
  /** Current-step runtime context and attribution. */
  readonly context: ContextSnapshot;
}

export type ObserveEvent =
  | {
      readonly type: "model.requested";
      readonly invocationId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly requestedModelId?: string;
      readonly attributes: ObserveModelRequested;
    }
  | {
      readonly type: "model.prepared";
      readonly invocationId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly requestedModelId?: string;
      readonly attributes: {
        readonly adapter: string;
        readonly call: JsonValue;
      };
    }
  | {
      readonly type: "model.completed";
      readonly invocationId?: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly requestedModelId?: string;
      readonly attributes: ModelCandidate;
    }
  | {
      readonly type: "step.started";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly turnNumber: number;
      readonly stepNumber: number;
      readonly attributes: {
        readonly arrivals: readonly InputEvent[];
        readonly toolResults: readonly ToolResult[];
        readonly transcript: readonly TranscriptEntry[];
      };
    }
  | {
      readonly type: "middleware.entered" | "middleware.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly middlewareId: string;
    }
  | {
      readonly type: "middleware.lease-violation";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly middlewareId: string;
      readonly reason: string;
    }
  | {
      readonly type: "tool.sealed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly attributes: {
        readonly executable: readonly ObserveSealedCall[];
        readonly immediate: readonly ToolResult[];
      };
    }
  | {
      readonly type: "tool.started";
      readonly executionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly toolName: string;
      readonly callId: string;
      readonly invocationId: string;
      readonly middlewareId: string;
      readonly slot: string;
      readonly attributes: { readonly args: JsonValue };
    }
  | {
      readonly type: "tool.progress";
      readonly executionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly toolName: string;
      readonly callId: string;
      readonly invocationId: string;
      readonly middlewareId: string;
      readonly slot: string;
      readonly attributes: {
        readonly message: string;
        readonly data?: JsonObject;
      };
    }
  | {
      readonly type: "tool.completed";
      readonly executionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly toolName: string;
      readonly callId: string;
      readonly invocationId: string;
      readonly middlewareId: string;
      readonly slot: string;
      readonly outcome: string;
      readonly code?: string;
      readonly attributes?: ToolResult;
    }
  | {
      readonly type: "tool.deferred";
      readonly executionId: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly toolName: string;
      readonly callId: string;
      readonly invocationId: string;
      readonly middlewareId: string;
      readonly slot: string;
      readonly attributes: { readonly token?: JsonValue };
    }
  | {
      readonly type: "delegation.started";
      readonly turnId: string;
      readonly stepId: string;
      readonly callId: string;
      readonly invocationId: string;
      readonly toolName: string;
      readonly agent: AgentRef;
      readonly attributes: { readonly task: string };
    }
  | {
      readonly type: "delegation.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly callId: string;
      readonly invocationId: string;
      readonly toolName: string;
      readonly agent: AgentRef;
      /** The agent's own end state: completed, failed, cancelled or paused. */
      readonly status: string;
      readonly attributes: ToolResult;
    }
  | {
      readonly type: "turn.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly attributes: { readonly output: JsonValue };
    }
  | {
      readonly type: "interaction.required";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly interactionId: string;
      readonly kind: string;
      readonly callId?: string;
      readonly toolName?: string;
      readonly phase?: "interaction" | "execute";
      readonly attributes: {
        readonly prompt: string;
        readonly metadata?: JsonObject;
      };
    }
  | {
      readonly type: "tripwire";
      readonly turnId: string;
      readonly stepId?: string;
      readonly inputId?: string;
      readonly code: string;
      readonly scope: string;
      readonly attributes: { readonly message: string };
    };

export type Observer = (event: ObserveEvent) => void | Promise<void>;
