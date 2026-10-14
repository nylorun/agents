import type { AgentManifest } from "../types/manifest.js";
import type { BuiltAgent } from "../types/agent.js";
import type { ToolSchemaSource } from "../types/tool.js";
import type { DefinitionPart, BoundToolDefinition } from "./bound.js";
import type { Implementations } from "./implementations.js";
import { HarnessError } from "../errors.js";

/** Local code binding. Only manifest is serializable; functions stay in the application. */
export interface AgentBinding {
  readonly manifest: AgentManifest;
  readonly tools: readonly BoundToolDefinition[];
  readonly parts: readonly DefinitionPart[];
  readonly implementations: Implementations;
  readonly outputSchema?: ToolSchemaSource;
}
export function bindingFromAgent(agent: BuiltAgent): AgentBinding {
  if (!agent || typeof agent.getBinding !== "function")
    throw new HarnessError(
      "execution.invalid-input",
      "An agent with getBinding() is required"
    );
  return agent.getBinding();
}
export function implementationsFor(agent: BuiltAgent): Implementations {
  return bindingFromAgent(agent).implementations;
}
