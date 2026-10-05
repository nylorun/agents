import type { JsonObject } from "../types/shared.js";
import type {
  McpServerManifest,
  SandboxManifest,
  SkillManifest,
} from "../types/manifest.js";
import type { SkillRecord } from "../types/middleware.js";
import type { Delegate } from "./delegate.js";
import type {
  MiddlewareContributions,
  StepMiddleware,
} from "../types/middleware.js";
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
  /** Runs in the background when an Action endpoint serves it (`ToolDefinition.background`). */
  readonly background?: boolean;
  readonly owner: ToolOwner;
  readonly source: ToolDefinition<any, any, any>;
  /** Set when this tool is an agent used as a tool; the engine runs it. */
  readonly delegate?: Delegate;
}

export interface BoundMiddleware {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly handle: StepMiddleware;
  readonly hasMiddleware: boolean;
  readonly tools?: readonly ToolDefinition<any, any, any>[];
  /** Execution-only tools. Advertised for this run and omitted from the manifest. */
  readonly sessionTools?: readonly ToolDefinition<any, any, any>[];
  readonly contributions?: MiddlewareContributions;
  readonly manifestType?: "agent" | "agent-plugin";
  readonly metadata?: JsonObject;
  readonly skills?: Readonly<Record<string, SkillManifest>>;
  readonly skillRecords?: Readonly<Record<string, SkillRecord>>;
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
  readonly sandbox?: SandboxManifest;
}
