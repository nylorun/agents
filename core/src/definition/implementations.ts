import type { ToolDefinition } from "../types/tool.js";

/** In-process implementations table keyed by capability id (never serialized). */
export interface Implementations<Info = unknown> {
  readonly [capabilityId: string]: {
    readonly tools?: {
      readonly [toolName: string]: ToolDefinition<any, Info, any>;
    };
  };
}

export function emptyImplementations(): Implementations {
  return Object.freeze({});
}
