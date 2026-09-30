import type { ContextItem, JsonObject, JsonValue } from "./shared.js";
import type { InputEvent, TranscriptEntry } from "./transcript.js";
import type { ToolDescriptor, ToolResult } from "./tool.js";

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
}

export type ModelOutputBlock =
  | {
      readonly type: "text";
      readonly text: string;
      readonly providerMetadata?: JsonObject;
    }
  | {
      readonly type: "reasoning";
      readonly text: string;
      readonly providerMetadata?: JsonObject;
    }
  | { readonly type: "json"; readonly value: JsonValue }
  | {
      readonly type: "tool-call";
      readonly providerMetadata?: JsonObject;
      readonly id: string;
      readonly name: string;
      readonly args: JsonObject;
      readonly raw?: string;
    };

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  /** Input tokens written to the provider's prompt cache. */
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
}

export type ModelFinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "other";

export interface ModelEvidence {
  readonly requestId?: string;
  readonly resolvedModel?: string;
  readonly warnings?: readonly string[];
  readonly extras?: JsonObject;
}

export interface ModelCandidate {
  readonly output: readonly ModelOutputBlock[];
  readonly finishReason?: ModelFinishReason;
  readonly usage?: ModelUsage;
  readonly evidence?: ModelEvidence;
}

/** Why a model call failed in a known way (Model Calls §6.1). */
export type ModelFailureCode =
  | "context_overflow"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "transient"
  | "content_policy"
  | "auth"
  | "invalid_request"
  | "invalid_output";

/**
 * A model call that failed in a known way. It is a completed outcome, not a lost one:
 * the engine fails the step with `model.<code>` instead of treating the call as uncertain.
 */
export interface ModelFailureOutcome {
  readonly kind: "failed";
  readonly code: ModelFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface ModelControls {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelDirective {
  readonly id?: string;
  readonly controls?: ModelControls;
  readonly config?: JsonObject;
}

/** A middleware-owned declaration for the model-visible configuration. */
export interface ModelConfigurationMutationOptions {
  readonly order?: number;
  readonly reason?: string;
}

export interface ModelConfigurationContributor {
  readonly middlewareId: string;
  readonly slot: string;
  readonly order: number;
  readonly reason?: string;
}

export interface ModelConfigurationTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly contributor: ModelConfigurationContributor;
}

export interface ModelConfigurationInstruction {
  readonly text: string;
  readonly contributor: ModelConfigurationContributor;
}

export interface ModelConfigurationSnapshot {
  readonly version: 1;
  readonly model?: ModelDirective;
  readonly instructions: readonly ModelConfigurationInstruction[];
  /** Data-only descriptions of the selected tools. */
  readonly tools: readonly ToolDescriptor[];
  readonly toolContracts: readonly ModelConfigurationTool[];
  readonly contributors: readonly ModelConfigurationContributor[];
}

/** A middleware-owned declaration for this model call's runtime context. */
export interface ContextMutationOptions {
  readonly order?: number;
  readonly reason?: string;
}

export interface ContextContributor {
  readonly middlewareId: string;
  readonly slot: string;
  readonly order: number;
  readonly reason?: string;
}

/** Canonical runtime context for one model call. */
export interface ContextSnapshot {
  readonly items: readonly ContextItem[];
  readonly contributors: readonly ContextContributor[];
}

export interface ModelRequest {
  readonly executionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly model?: ModelDirective;
  /** Canonical, immutable Harness-owned model configuration for this call. */
  readonly configuration: ModelConfigurationSnapshot;
  readonly instructions: readonly string[];
  readonly context: ContextSnapshot;
  readonly transcript: readonly TranscriptEntry[];
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  /** Immutable tool descriptions; executable definitions stay inside Harness. */
  readonly tools: readonly ToolDescriptor[];
  /** Optional portable contract for this turn's terminal JSON result. */
  readonly outputSchema?: JsonObject;
}

export type PromptContentPart =
  | {
      readonly type: "reasoning";
      readonly text: string;
      readonly providerMetadata?: JsonObject;
    }
  | {
      readonly type: "text";
      readonly text: string;
      readonly providerMetadata?: JsonObject;
    }
  | {
      readonly type: "media";
      readonly mediaType: string;
      readonly reference: JsonValue;
    }
  | {
      readonly type: "tool-call";
      readonly providerMetadata?: JsonObject;
      readonly id: string;
      readonly name: string;
      readonly args: JsonObject;
    };

/** The provider, API and model that produced an assistant message (Model Calls §12). */
export interface ModelProducer {
  readonly provider: string;
  readonly api?: string;
  readonly model: string;
}

export type PromptItem =
  | {
      readonly kind: "instructions";
      readonly role: "system";
      readonly content: readonly PromptContentPart[];
    }
  | {
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly content: readonly PromptContentPart[];
      /** For assistant messages: the model that produced it, when the adapter recorded one. */
      readonly producer?: ModelProducer;
    }
  | {
      readonly kind: "tool-result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "completed" | "denied" | "failed";
      readonly content: readonly PromptContentPart[];
    }
  | {
      readonly kind: "context";
      readonly role: "user";
      readonly content: readonly PromptContentPart[];
    };

export interface ModelCallTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

export interface ModelCall {
  readonly model?: ModelDirective;
  readonly prompt: readonly PromptItem[];
  readonly tools: readonly ModelCallTool[];
  /** Optional portable contract for this turn's terminal JSON result. */
  readonly outputSchema?: JsonObject;
  readonly executionId: string;
}

export interface ModelAdapterContext {
  readonly request: ModelRequest;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  /** Set when the engine calls the model to summarize history (Model Calls §8). */
  readonly compaction?: {
    readonly trigger: "threshold" | "overflow";
    readonly tokensBefore: number;
    readonly keptTokens: number;
    /** An intermediate call of a chunked summary; only the last one completes the compaction. */
    readonly partial?: boolean;
  };
  /** Publishes one JSON-safe provider request derived from the canonical ModelCall. */
  reportPreparedCall(prepared: ModelPreparedCall): void;
}

export interface ModelPreparedCall {
  readonly adapter: string;
  readonly call: JsonValue;
}

export type ModelAdapter = (
  call: ModelCall,
  context: ModelAdapterContext
) => Promise<ModelCandidate | ModelFailureOutcome | string>;
