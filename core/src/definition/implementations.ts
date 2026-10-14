import type { ToolDefinition } from "../types/tool.js";

/**
 * The code of an agent's tools, by tool name, for `Agent.from(manifest, implementations)` (never
 * serialized). Agents used as tools, HTTP tools and the Runtime's tools need none.
 */
export interface Implementations<Info = unknown> {
  readonly tools?: {
    readonly [toolName: string]: ToolDefinition<any, Info, any>;
  };
}

export function emptyImplementations(): Implementations {
  return Object.freeze({});
}
