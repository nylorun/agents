import type {
  ContextMutationOptions,
  ModelCandidate,
  ModelDirective,
  ModelToolCall,
  ModelConfigurationMutationOptions,
} from "./model.js";
import type { InputEvent, TranscriptEntry } from "./transcript.js";
import type { AgentTool } from "./agent.js";
import type {
  McpServerManifest,
  SkillManifest,
} from "./manifest.js";

/** Skill files held on the developer binding. Not a manifest field. */
export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly resources?: Readonly<Record<string, string>>;
}
import type { ContextItem, JsonObject, Tripwire } from "./shared.js";
import type { Interaction, ToolDefinition, ToolResult } from "./tool.js";

interface StepRequestBase {
  /** Opaque identity of the execution that owns this Step. */
  readonly executionId: string;
  /** Opaque identity of the Turn that owns this Step. */
  readonly turnId: string;
  /** Opaque identity of this Model Step. */
  readonly stepId: string;

  readonly turnNumber: number;
  readonly stepNumber: number;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
  readonly context: {
    set(
      slot: string,
      items: readonly ContextItem[],
      options?: ContextMutationOptions
    ): void;
  };
  readonly configuration: {
    readonly instructions: {
      set(
        slot: string,
        items: readonly string[],
        options?: ModelConfigurationMutationOptions
      ): void;
    };
    readonly tools: {
      set(
        slot: string,
        tools: readonly ToolDefinition[],
        options?: ModelConfigurationMutationOptions
      ): void;
    };
    readonly model: {
      select(
        directive: ModelDirective,
        options?: Omit<ModelConfigurationMutationOptions, "order">
      ): void;
      replace(
        directive: ModelDirective,
        options?: Omit<ModelConfigurationMutationOptions, "order">
      ): void;
      clear(options?: Omit<ModelConfigurationMutationOptions, "order">): void;
    };
  };
  tripwire(error: Tripwire): StepResponse;
}

export type StepRequest<Info = unknown> = StepRequestBase & {
  readonly info?: Info;
};

export interface StepResponse {
  candidate(): Readonly<ModelCandidate> | undefined;
  toolCalls(): readonly ModelToolCall[];
  replace(candidate: ModelCandidate): void;
  deny(callId: string, reason: string): void;
  requireInteraction(callId: string, interaction: Interaction): void;
  tripwire(error: Tripwire): StepResponse;
}

export type StepMiddleware<Info = unknown> = (
  request: StepRequest<Info>,
  next: () => Promise<StepResponse>
) => Promise<StepResponse>;

export type CapabilityItems<Item> =
  | readonly Item[]
  | Readonly<{ readonly slot: string; readonly items: readonly Item[] }>;

export interface CapabilityDeclaration<Info = unknown> {
  readonly id: string;
  readonly type?: "agent" | "agent-plugin";
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly tools?: CapabilityItems<ToolDefinition<any, Info, any>>;
  readonly instructions?: CapabilityItems<string>;
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  /** File contents for load_skill. Omitted from the manifest. */
  readonly skillRecords?: Readonly<Record<string, SkillRecord>>;
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
  /**
   * @deprecated Model resolution is Runtime-owned. Not projected into the harness manifest.
   * Kept for local middleware composition through 1.0.
   */
  readonly model?: ModelDirective;
  /** @deprecated Runs in the local engine only. Kept through 1.0. */
  readonly middleware?: StepMiddleware<Info>;
}

/** What `.use()` accepts: a capability whose `tools` may also hold agents used as tools. */
export type CapabilityInput<Info = unknown> = Omit<CapabilityDeclaration<Info>, "tools"> & {
  readonly tools?: CapabilityItems<ToolDefinition<any, Info, any> | AgentTool>;
};

export interface MiddlewareContributions {
  readonly instructions?: readonly string[];
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
  }[];
  readonly model?: Pick<ModelDirective, "id" | "controls">;
}
