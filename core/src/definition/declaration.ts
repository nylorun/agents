import type { BoundMiddleware } from "./bound.js";
import type {
  CapabilityInput,
  CapabilityItems,
  MiddlewareContributions,
  StepMiddleware,
} from "../types/middleware.js";
import type { ModelDirective } from "../types/model.js";
import type { ToolDefinition } from "../types/tool.js";
import type { AgentTool } from "../types/agent.js";
import type { SandboxManifest } from "../types/manifest.js";
import { delegateTool, isAgentItem } from "./delegate.js";
import { HarnessError } from "../errors.js";
import { REMOVED_CAPABILITY_FIELDS } from "./removed.js";

export interface CompiledCapability {
  readonly bound: BoundMiddleware;
  readonly middleware?: StepMiddleware<any>;
}

export function compileDeclaration<State>(
  declaration: CapabilityInput<State>
): CompiledCapability {
  for (const field of ["before", "after"])
    if ((declaration as Record<string, unknown>)[field] !== undefined)
      throw new HarnessError(
        "configuration.invalid",
        `Capability '${declaration.id}': ${REMOVED_CAPABILITY_FIELDS.hooks}`
      );
  const tools = asTools(copyItems(declaration.tools, declaration.id));
  const instructions = copyItems(declaration.instructions, declaration.id);
  const model = declaration.model;
  const contributions = snapshotContributions(
    instructions?.items,
    tools?.items,
    model
  );
  const handle: StepMiddleware = async (request, next) => {
    if (tools) request.configuration.tools.set(tools.slot, tools.items);
    if (instructions)
      request.configuration.instructions.set(
        instructions.slot,
        instructions.items
      );
    if (model) request.configuration.model.select(model);
    return declaration.middleware
      ? declaration.middleware(request as never, next)
      : next();
  };
  return {
    bound: {
      id: declaration.id,
      ...(declaration.name === undefined ? {} : { name: declaration.name }),
      ...(declaration.description === undefined
        ? {}
        : { description: declaration.description }),
      handle,
      hasMiddleware: declaration.middleware !== undefined,
      tools: tools?.items,
      ...(contributions === undefined ? {} : { contributions }),
      ...(declaration.type === undefined ? {} : { manifestType: declaration.type }),
      ...(declaration.metadata === undefined
        ? {}
        : { metadata: declaration.metadata }),
      ...(declaration.skills === undefined ||
      Object.keys(declaration.skills).length === 0
        ? {}
        : { skills: declaration.skills }),
      ...(declaration.skillFiles === undefined ||
      Object.keys(declaration.skillFiles).length === 0
        ? {}
        : { skillFiles: declaration.skillFiles }),
      ...(declaration.mcpServers === undefined ||
      Object.keys(declaration.mcpServers).length === 0
        ? {}
        : { mcpServers: declaration.mcpServers }),
      // Definitions declare no sandbox; carry one through so the build can refuse it by name.
      ...(sandboxOf(declaration) === undefined
        ? {}
        : { sandbox: sandboxOf(declaration) }),
    },
    ...(declaration.middleware ? { middleware: declaration.middleware } : {}),
  };
}

function snapshotContributions(
  instructions: readonly string[] | undefined,
  tools:
    | readonly { readonly name: string; readonly description?: string }[]
    | undefined,
  model: ModelDirective | undefined
): MiddlewareContributions | undefined {
  const snapInstructions =
    instructions === undefined ? undefined : Object.freeze([...instructions]);
  const snapTools =
    tools === undefined
      ? undefined
      : Object.freeze(
          tools.map((tool) =>
            Object.freeze({
              name: tool.name,
              ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
            })
          )
        );
  // Model is Runtime-owned for the published manifest; still allow local middleware select().
  void model;
  if (snapInstructions === undefined && snapTools === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(snapInstructions === undefined
      ? {}
      : { instructions: snapInstructions }),
    ...(snapTools === undefined ? {} : { tools: snapTools }),
  });
}

function copyItems<Item>(
  value: CapabilityItems<Item> | undefined,
  defaultSlot: string
):
  | Readonly<{ readonly slot: string; readonly items: readonly Item[] }>
  | undefined {
  if (value === undefined) return undefined;
  if (!("items" in value))
    return Object.freeze({
      slot: defaultSlot,
      items: Object.freeze([...value]),
    });
  return Object.freeze({
    slot: value.slot,
    items: Object.freeze([...value.items]),
  });
}

/** Agents placed in `tools` become the tools that delegate to them. */
function asTools(
  value:
    | Readonly<{ readonly slot: string; readonly items: readonly (ToolDefinition<any, any, any> | AgentTool)[] }>
    | undefined
):
  | Readonly<{ readonly slot: string; readonly items: readonly ToolDefinition<any, any, any>[] }>
  | undefined {
  if (value === undefined) return undefined;
  if (!value.items.some(isAgentItem))
    return value as Readonly<{ slot: string; items: readonly ToolDefinition<any, any, any>[] }>;
  return Object.freeze({
    slot: value.slot,
    items: Object.freeze(
      value.items.map((item) => (isAgentItem(item) ? delegateTool(item) : (item as ToolDefinition)))
    ),
  });
}

function sandboxOf(declaration: object): SandboxManifest | undefined {
  return (declaration as { sandbox?: SandboxManifest }).sandbox;
}
