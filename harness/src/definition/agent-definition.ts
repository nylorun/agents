import type { BoundMiddleware } from "@nylorun/core/define";
import type { ToolRegistry } from "./registry.js";
import type { TurnOutputContract } from "@nylorun/core/define";
import type { AgentManifest } from "@nylorun/core/define";
import type { Implementations } from "@nylorun/core/define";

export interface AgentDefinition {
  readonly id: string;
  readonly middleware: readonly BoundMiddleware[];
  readonly registry: ToolRegistry;
  readonly output?: TurnOutputContract;
  readonly manifest: AgentManifest;
  readonly hash: string;
  readonly implementations: Implementations;
}

export type { Implementations };

import { bindingFromAgent, bindOutputContract } from "@nylorun/core/define";
import type { AgentBinding, BuiltAgent } from "@nylorun/core/define";
import { ToolRegistry as Registry } from "./registry.js";
import { hashManifest } from "@nylorun/core/compatibility";
export function definitionFor(agent: object): AgentDefinition {
  return definitionFromBinding(bindingFromAgent(agent as BuiltAgent));
}
export function definitionFromBinding(binding: AgentBinding): AgentDefinition {
  return Object.freeze({
    id: binding.manifest.id,
    manifest: binding.manifest,
    hash: hashManifest(binding.manifest),
    middleware: binding.declarations,
    implementations: binding.implementations,
    registry: new Registry(binding.declarations, binding.tools),
    ...(binding.outputSchema ? { output: bindOutputContract(binding.outputSchema) } : {}),
  });
}
export function tryDefinitionFor(agent: object): AgentDefinition | undefined {
  return typeof (agent as BuiltAgent).getBinding === "function" ? definitionFor(agent) : undefined;
}
