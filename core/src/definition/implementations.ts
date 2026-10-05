import type { ToolDefinition } from "../types/tool.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { AgentManifest } from "../types/manifest.js";

/** In-process implementations table keyed by capability id (never serialized). */
export interface Implementations<Info = unknown> {
  readonly [capabilityId: string]: {
    readonly tools?: {
      readonly [toolName: string]: ToolDefinition<any, Info, any>;
    };
    /** @deprecated Local engine only through 1.0. */
    readonly middleware?: StepMiddleware<Info>;
  };
}

export function emptyImplementations(): Implementations {
  return Object.freeze({});
}
