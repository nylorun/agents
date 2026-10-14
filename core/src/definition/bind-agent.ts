import { bindTool } from "./bind-tool.js";
import { HarnessError } from "../errors.js";
import type { BoundToolDefinition } from "./bound.js";
import type { AgentManifest } from "../types/manifest.js";
import type { DefinitionPart } from "./bound.js";
import type { BuiltAgent } from "../types/agent.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract } from "./output-contract.js";
import type { AgentBinding } from "./binding.js";
import type { Implementations } from "./implementations.js";
export function bindAgent(
  parts: readonly DefinitionPart[],
  manifest: AgentManifest,
  options: { outputSchema?: ToolSchemaSource } = {}
): BuiltAgent {
  const seen = new Set<object>();
  const names = new Set<string>();
  const tools: BoundToolDefinition[] = [];
  for (const part of parts)
    for (const tool of [...(part.tools ?? []), ...(part.sessionTools ?? [])]) {
      if (seen.has(tool) || names.has(tool.name))
        throw new HarnessError("tool.invalid", `Duplicate registered tool '${tool.name}'`);
      seen.add(tool);
      names.add(tool.name);
      tools.push(bindTool(tool, { partId: part.id, slot: part.id }));
    }
  const implementations: Implementations = Object.freeze(
    tools.length === 0
      ? {}
      : { tools: Object.freeze(Object.fromEntries(tools.map((tool) => [tool.name, tool]))) }
  );
  const binding: AgentBinding = Object.freeze({
    parts,
    tools: Object.freeze(tools),
    ...(options.outputSchema === undefined
      ? {}
      : { outputSchema: options.outputSchema }),
    manifest,
    implementations,
  });
  // Validate the live output schema at authoring time without compiling engine state.
  if (options.outputSchema) bindOutputContract(options.outputSchema);
  const agent = {
    id: manifest.id,
    name: manifest.name,
    manifest,
    toJSON: () => manifest,
  } as BuiltAgent;
  Object.defineProperty(agent, "getBinding", {
    value: () => binding,
    enumerable: false,
  });
  return agent;
}
