import type { AgentTool, BuiltAgent } from "../../types/agent.js";
import type { JsonObject } from "../../types/shared.js";
import type { ToolDefinition } from "../../types/tool.js";
import type {
  WorkflowAgentNode,
  WorkflowNode,
  WorkflowToolNode,
} from "../../types/workflow.js";
import { bindingFromAgent } from "../binding.js";
import type { AgentBinding } from "../binding.js";
import type { BoundToolDefinition } from "../bound.js";
import { normalizeToolDefinition, normalizeSchema } from "../schema.js";
import { HarnessError } from "../../errors.js";
import type { ToolSchema, ToolSchemaSource } from "../../types/tool.js";
import { isBuiltWorkflow, type BuiltWorkflow } from "./types.js";
import { failOne } from "./diagnostics.js";
import { isSlot, type ChildRef, type Slot } from "./slot.js";

/** Anything a primitive accepts as a child (or a slot wrapping one). */
export type WorkflowRunnable =
  | BuiltAgent
  | AgentTool
  | { build(): BuiltAgent }
  | ToolDefinition<any, any, any>
  | BuiltWorkflow;

export type ResolvedChild = {
  readonly id: string;
  readonly node: WorkflowNode;
  readonly agents: Record<string, AgentBinding>;
  /** Nested workflow implementations, keyed relative to the child root id. */
  readonly nodes: Record<string, import("../../types/workflow.js").WorkflowNodeImplementation>;
  readonly tool?: BoundToolDefinition;
  readonly sandboxSpecs: readonly JsonObject[];
  readonly isReshapingSlot: boolean;
};

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!value || typeof value !== "object") return false;
  if (!("name" in value) || typeof (value as { name: unknown }).name !== "string") return false;
  const v = value as ToolDefinition;
  return (
    typeof v.execute === "function" ||
    typeof v.run === "function" ||
    v.inputSchema !== undefined ||
    v.input !== undefined
  );
}

function isAgentLike(value: unknown): value is BuiltAgent | AgentTool {
  if (!value || typeof value !== "object") return false;
  if (isBuiltWorkflow(value)) return false;
  return (
    "id" in value &&
    typeof (value as BuiltAgent).id === "string" &&
    "manifest" in value &&
    typeof (value as BuiltAgent).getBinding === "function"
  );
}

function builtAgentOf(run: BuiltAgent | AgentTool | { build(): BuiltAgent }): BuiltAgent {
  if (
    run &&
    typeof run === "object" &&
    "getBinding" in run &&
    typeof run.getBinding === "function" &&
    "manifest" in run &&
    !isBuiltWorkflow(run)
  )
    return run as BuiltAgent;
  if (run && typeof run === "object" && "build" in run && typeof run.build === "function")
    return run.build();
  failOne("workflow.invalid-runnable", "Expected a built agent or Agent builder");
}

/** Collect sandbox specs declared on an agent (and its delegates, one level). */
export function sandboxSpecsOf(agent: BuiltAgent | AgentTool): JsonObject[] {
  const specs: JsonObject[] = [];
  const binding = bindingFromAgent(agent as BuiltAgent);
  for (const cap of binding.manifest.capabilities) {
    if (cap.sandbox) specs.push(cap.sandbox as JsonObject);
  }
  for (const tool of binding.tools) {
    const child = tool.delegate?.agent;
    if (!child) continue;
    for (const cap of child.manifest.capabilities) {
      if (cap.sandbox) specs.push(cap.sandbox as JsonObject);
    }
  }
  return specs;
}

/**
 * Project a tool for use as a workflow node.
 * Unlike agent tools, workflow tool nodes may take any JSON Schema root type (workflows.md §9).
 * Built without `bindTool` so we skip the agent-only object-input rule in `normalizeSchema`.
 */
function bindToolNode(tool: ToolDefinition): BoundToolDefinition {
  const normalized = normalizeToolDefinition(tool);
  if (!normalized.name)
    throw new HarnessError("tool.invalid-name", "Tool name must not be empty");
  const execute = normalized.execute ?? normalized.run;
  if (typeof execute !== "function")
    throw new HarnessError(
      "tool.invalid",
      `Tool '${normalized.name}' must provide run() or execute()`,
    );
  const rawInput = (normalized.inputSchema ?? normalized.input) as ToolSchemaSource | undefined;
  if (!rawInput)
    throw new HarnessError(
      "tool.invalid-schema",
      `Tool '${normalized.name}' must provide input or inputSchema`,
    );
  // role "output" skips the object-root check used for agent tool inputs.
  const inputSchema = schemaForNode(rawInput, "input");
  const rawOutput = (normalized.outputSchema ?? normalized.output) as
    | ToolSchemaSource
    | undefined;
  const outputSchema = rawOutput ? schemaForNode(rawOutput, "output") : undefined;
  return Object.freeze({
    source: tool,
    name: normalized.name,
    ...(normalized.description ? { description: normalized.description } : {}),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    execute: execute.bind(normalized) as BoundToolDefinition["execute"],
    ...(normalized.approval === undefined ? {} : { approval: normalized.approval }),
    ...(normalized.effects === undefined ? {} : { effects: normalized.effects }),
    owner: Object.freeze({ middlewareId: "workflow", slot: "tool-node" }),
  });
}

/** Normalize a schema for a workflow tool node (any JSON Schema root type allowed). */
function schemaForNode(
  source: ToolSchemaSource,
  role: "input" | "output",
): ToolSchema<unknown> {
  if (
    source &&
    typeof source === "object" &&
    "jsonSchema" in source &&
    typeof (source as ToolSchema<unknown>).validate === "function"
  )
    return source as ToolSchema<unknown>;
  // Pass role "output" so normalizeSchema does not require an object root.
  return normalizeSchema(source, role === "input" ? "output" : role);
}

function toolManifestNode(bound: BoundToolDefinition): WorkflowToolNode {
  return {
    tool: {
      name: bound.name,
      ...(bound.description === undefined ? {} : { description: bound.description }),
      inputSchema: bound.inputSchema.jsonSchema,
      ...(bound.outputSchema === undefined
        ? {}
        : { outputSchema: bound.outputSchema.jsonSchema }),
    },
  };
}

function agentNode(agent: BuiltAgent): {
  node: WorkflowAgentNode;
  agents: Record<string, AgentBinding>;
  sandboxSpecs: JsonObject[];
} {
  const binding = bindingFromAgent(agent);
  return {
    node: { agent: agent.id },
    agents: { [agent.id]: binding },
    sandboxSpecs: sandboxSpecsOf(agent),
  };
}

function resolveRunnable(run: WorkflowRunnable, rename?: string): ResolvedChild {
  if (isBuiltWorkflow(run)) {
    const binding = run.getBinding();
    const id = rename ?? run.id;
    return {
      id,
      node: binding.manifest.root,
      agents: { ...binding.agents },
      // A rename moves the whole subtree: the harness path uses the new part, not run.id.
      nodes: remapNodeKeys({ ...binding.nodes }, run.id, id),
      sandboxSpecs: sandboxSpecsFromAgents(binding.agents),
      isReshapingSlot: false,
    };
  }
  if (isToolDefinition(run)) {
    const bound = bindToolNode(run);
    const id = rename ?? bound.name;
    return {
      id,
      node: toolManifestNode(bound),
      agents: {},
      nodes: { [id]: { kind: "tool", tool: bound } },
      tool: bound,
      sandboxSpecs: [],
      isReshapingSlot: false,
    };
  }
  if (
    isAgentLike(run) ||
    (run && typeof run === "object" && "build" in run && typeof run.build === "function")
  ) {
    const agent = builtAgentOf(run as BuiltAgent | AgentTool | { build(): BuiltAgent });
    const resolved = agentNode(agent);
    const id = rename ?? agent.id;
    return {
      id,
      node: resolved.node,
      agents: resolved.agents,
      nodes: {},
      sandboxSpecs: resolved.sandboxSpecs,
      isReshapingSlot: false,
    };
  }
  failOne("workflow.invalid-runnable", "Unsupported workflow runnable");
}

function sandboxSpecsFromAgents(
  agents: Readonly<Record<string, AgentBinding>>,
): JsonObject[] {
  const specs: JsonObject[] = [];
  for (const binding of Object.values(agents)) {
    for (const cap of binding.manifest.capabilities) {
      if (cap.sandbox) specs.push(cap.sandbox as JsonObject);
    }
  }
  return specs;
}

/**
 * Resolve a runnable or slot into a manifest node plus local bindings.
 * When the slot has `input`, the node is wrapped as `{ slot: { id?, input, run } }`.
 */
export function resolveChild(child: ChildRef, defaultRename?: string): ResolvedChild {
  if (isSlot(child)) {
    const slot = child as Slot;
    const resolved = resolveRunnable(slot.run, slot.id ?? defaultRename);
    const id = slot.id ?? resolved.id;
    const hasInput = typeof slot.input === "function";
    if (!hasInput && slot.id === undefined) {
      return { ...resolved, id, isReshapingSlot: false };
    }
    const node: WorkflowNode = {
      slot: {
        ...(slot.id !== undefined ? { id: slot.id } : {}),
        ...(hasInput ? { input: { fn: true as const } } : {}),
        run: resolved.node,
      },
    };
    const remapped = remapNodeKeys(resolved.nodes, resolved.id, id);
    if (hasInput) {
      remapped[`${id}/input`] = {
        kind: "fn",
        fn: slot.input as (...args: never[]) => unknown,
      };
    }
    return {
      id,
      node,
      agents: resolved.agents,
      nodes: remapped,
      tool: resolved.tool,
      sandboxSpecs: resolved.sandboxSpecs,
      isReshapingSlot: hasInput,
    };
  }
  return resolveRunnable(child as WorkflowRunnable, defaultRename);
}

/**
 * Rewrite node keys that are rooted at `fromRoot` so they sit at `toPath`.
 * Used when nesting a child under a parent path (workflows.md §6).
 *
 * Example: Loop nodes `{ code, code/decide }` nested at `ship/code` become
 * `{ ship/code, ship/code/decide }`.
 */
export function remapNodeKeys(
  nodes: Record<string, import("../../types/workflow.js").WorkflowNodeImplementation>,
  fromRoot: string,
  toPath: string,
): Record<string, import("../../types/workflow.js").WorkflowNodeImplementation> {
  if (fromRoot === toPath) return nodes;
  const out: Record<string, import("../../types/workflow.js").WorkflowNodeImplementation> = {};
  for (const [key, impl] of Object.entries(nodes)) {
    if (key === fromRoot) out[toPath] = impl;
    else if (key.startsWith(`${fromRoot}/`))
      out[`${toPath}${key.slice(fromRoot.length)}`] = impl;
    else out[`${toPath}/${key}`] = impl;
  }
  return out;
}

/** @deprecated Prefer remapNodeKeys — kept for call-site clarity during migration. */
export function prefixNodeKeys(
  nodes: Record<string, import("../../types/workflow.js").WorkflowNodeImplementation>,
  parentPath: string,
): Record<string, import("../../types/workflow.js").WorkflowNodeImplementation> {
  return remapNodeKeys(nodes, "", parentPath);
}

export function runnableId(child: ChildRef): string {
  if (isSlot(child)) {
    if (child.id !== undefined) return child.id;
    return runnableId(child.run);
  }
  if (isBuiltWorkflow(child)) return child.id;
  if (isToolDefinition(child)) return child.name;
  if (isAgentLike(child)) return child.id;
  if (child && typeof child === "object" && "build" in child && typeof child.build === "function")
    return child.build().id;
  failOne("workflow.invalid-runnable", "Cannot determine runnable id");
}
