import { bindTool } from "./bind-tool.js";
import { HarnessError } from "../errors.js";
import type { BoundToolDefinition } from "./bound.js";
import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "./bound.js";
import type { BuiltAgent } from "../types/agent.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract } from "./output-contract.js";
import type { AgentBinding } from "./binding.js";
import type { CapabilityDynamics } from "./assemble.js";
import type { Implementations } from "./implementations.js";
export function bindAgent(
  middleware: readonly BoundMiddleware[],
  manifest: AgentManifest,
  options: { outputSchema?: ToolSchemaSource } = {},
  dynamics: ReadonlyMap<string, CapabilityDynamics> = new Map()
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
  const implementations = buildImplementations(middleware, dynamics, tools);
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
  middleware: readonly BoundMiddleware[],
  dynamics: ReadonlyMap<string, CapabilityDynamics>,
  snapshots: readonly BoundToolDefinition[]
): Implementations {
  const table: Record<string, Implementations[string]> = {};
  for (const item of middleware) {
    const tools: Record<string, NonNullable<BoundMiddleware["tools"]>[number]> =
      {};
    for (const tool of snapshots.filter(
      (tool) => tool.owner.middlewareId === item.id
    ))
      tools[tool.name] = tool;
    const dyn = dynamics.get(item.id);
    table[item.id] = Object.freeze({
      ...(Object.keys(tools).length
        ? { tools: Object.freeze({ ...tools }) }
        : {}),
      ...(dyn?.middleware ? { middleware: dyn.middleware } : {}),
    });
  }
  return Object.freeze(table);
}
