import type {
  McpServerManifest,
  SandboxManifest,
  SkillManifest,
} from "../types/manifest.js";
import type { Delegate } from "./delegate.js";
import type { SkillFileSource } from "../types/part.js";
import type {
  ToolApproval,
  ToolDefinition,
  ToolEffects,
  ToolExecutionContext,
  ToolInputSchema,
  ToolOutcome,
  ToolOutputSchema,
  ToolOwner,
  ToolRunResult,
  ToolSchema,
} from "../types/tool.js";

export interface BoundToolDefinition<Info = unknown>
  extends Omit<
    ToolDefinition<ToolInputSchema, Info, ToolOutputSchema | undefined>,
    "inputSchema" | "outputSchema" | "execute" | "run" | "input" | "output"
  > {
  readonly inputSchema: ToolSchema<unknown>;
  readonly outputSchema?: ToolSchema<unknown>;
  readonly execute: (
    args: unknown,
    context: ToolExecutionContext<Info>
  ) => Promise<ToolRunResult>;
  readonly approval?: ToolApproval<ToolInputSchema>;
  readonly effects?: ToolEffects;
  readonly owner: ToolOwner;
  readonly source: ToolDefinition<any, any, any>;
  /** Set when this tool is an agent used as a tool; the engine runs it. */
  readonly delegate?: Delegate;
}

/**
 * One part of an agent definition: what one builder call, skills folder or plugin added, or (in
 * an agent rebuilt from a pinned manifest) the `runtime` block. The engine offers each part's
 * tools and instructions to the model in part order; the manifest holds the parts merged.
 */
export interface DefinitionPart {
  readonly id: string;
  readonly tools?: readonly ToolDefinition<any, any, any>[];
  /** Execution-only tools. Advertised for this run and omitted from the manifest. */
  readonly sessionTools?: readonly ToolDefinition<any, any, any>[];
  readonly instructions?: readonly string[];
  /** Text the model reads while the session tools are advertised. Not in the manifest. */
  readonly sessionInstructions?: readonly string[];
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  /** Each skill file's bytes, by `sha256:<hex>`. Not a manifest field. */
  readonly skillFiles?: Readonly<Record<string, SkillFileSource>>;
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
  readonly sandbox?: SandboxManifest;
}
