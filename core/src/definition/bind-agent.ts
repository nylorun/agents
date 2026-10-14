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
  middleware: readonly DefinitionPart[],
  manifest: AgentManifest,
  options: { outputSchema?: ToolSchemaSource } = {}
): BuiltAgent {
  const seen = new Set<object>();
  const keys = new Set<string>();
  const tools: BoundToolDefinition[] = [];
  for (const declaration of middleware)
    for (const tool of [
      ...(declaration.tools ?? []),
      ...(declaration.sessionTools ?? []),
    ]) {
      const key = JSON.stringify([declaration.id, tool.name]);
      if (seen.has(tool) || keys.has(key))
        throw new HarnessError(
          "tool.invalid",
          `Duplicate registered tool '${tool.name}' in '${declaration.id}'`
        );
      seen.add(tool);
      keys.add(key);
      tools.push(
        bindTool(tool, { middlewareId: declaration.id, slot: declaration.id })
      );
    }
  const implementations = buildImplementations(middleware, tools);
  const binding: AgentBinding = Object.freeze({
    declarations: middleware,
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

function buildImplementations(
  middleware: readonly DefinitionPart[],
  snapshots: readonly BoundToolDefinition[]
): Implementations {
  const table: Record<string, Implementations[string]> = {};
  for (const item of middleware) {
    const tools: Record<string, NonNullable<DefinitionPart["tools"]>[number]> =
      {};
    for (const tool of snapshots.filter(
      (tool) => tool.owner.middlewareId === item.id
    ))
      tools[tool.name] = tool;
    table[item.id] = Object.freeze(
      Object.keys(tools).length ? { tools: Object.freeze({ ...tools }) } : {}
    );
  }
  return Object.freeze(table);
}
