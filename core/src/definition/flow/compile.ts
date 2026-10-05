/**
 * Compile a flow agent's stages to workflow manifest v3.
 *
 * Each stage becomes one node with an optional `id`; leaf agents are embedded in
 * `agents`; tool nodes are bound under their stage keys. Paths and keys follow
 * `./paths.ts`.
 */
import type { JsonObject, BuildDiagnostic } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import type { AgentManifest } from "../../types/manifest.js";
import type { BuiltAgent } from "../../types/agent.js";
import { httpToolOf } from "../http-tool.js";
import type {
  WorkflowBinding,
  WorkflowManifest,
  WorkflowNode,
  WorkflowNodeImplementation,
} from "../../types/workflow.js";
import type { AgentBinding } from "../binding.js";
import { bindingFromAgent } from "../binding.js";
import type { BoundToolDefinition } from "../bound.js";
import { bindOutputContract } from "../output-contract.js";
import { copyJsonObject } from "../../utils/immutable.js";
import { canonical } from "../../utils/canonical.js";
import { diagnostic, fail } from "../workflow/diagnostics.js";
import { isBuiltWorkflow, type BuiltWorkflow } from "../workflow/types.js";
import {
  bindToolNode,
  builtAgentOf,
  isToolDefinition,
  toolManifestNode,
} from "../workflow/runnable.js";
import { isFlowBuilder, isNamedChild, type FlowStage } from "./spec.js";
import { forEachFlowNode, leafPart } from "./paths.js";

export interface CompileFlowOptions {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly stages: readonly FlowStage[];
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
}

/** What a node binds locally; attached to node objects while compiling. */
type NodeCode = {
  tool?: BoundToolDefinition;
  /** A nested flow agent: its bindings move under this node's key. */
  nested?: WorkflowBinding;
};

type Build = {
  readonly id: string;
  readonly code: WeakMap<object, NodeCode>;
  readonly agents: Record<string, AgentManifest | WorkflowManifest>;
  readonly bindings: Record<string, AgentBinding>;
  readonly diagnostics: BuildDiagnostic[];
};

/** Compile a flow agent. Throws `WorkflowBuildError` with diagnostics. */
export function compileAgentFlow(options: CompileFlowOptions): BuiltWorkflow {
  const stages = expand(options.stages);
  if (stages.length === 0)
    fail([
      diagnostic(
        "flow.empty",
        `Flow agent '${options.id}' has no stages. Add .pipe(), .switch(), .parallel(), .map() or .loop().`
      ),
    ]);
  const build: Build = {
    id: options.id,
    code: new WeakMap(),
    agents: {},
    bindings: {},
    diagnostics: [],
  };
  const root: WorkflowNode = { chain: stages.map((stage) => compileStage(stage, build)) };
  const nodes = bindNodes(root, build);
  if (build.diagnostics.length) fail(build.diagnostics);

  const manifest: WorkflowManifest = {
    kind: "workflow",
    workflowSchemaVersion: 3,
    id: options.id,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.metadata === undefined
      ? {}
      : { metadata: copyJsonObject(options.metadata, "metadata") }),
    ...(options.inputSchema === undefined ? {} : { inputSchema: jsonSchemaOf(options.inputSchema) }),
    ...(options.outputSchema === undefined
      ? {}
      : { outputSchema: jsonSchemaOf(options.outputSchema) }),
    root,
    agents: build.agents,
  };
  const binding: WorkflowBinding = Object.freeze({
    manifest,
    nodes: Object.freeze(nodes),
    agents: Object.freeze({ ...build.bindings }),
  });
  const built = {
    id: options.id,
    manifest,
    toJSON: () => manifest,
    ...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  } as BuiltWorkflow;
  Object.defineProperty(built, "getBinding", { value: () => binding, enumerable: false });
  return built;
}

/** Inline `.pipe(flow())` sequences that have no id into their parent. */
function expand(stages: readonly FlowStage[]): FlowStage[] {
  const out: FlowStage[] = [];
  for (const stage of stages) {
    if (stage.kind === "step" && isFlowBuilder(stage.child) && stage.id === undefined)
      out.push(...expand(stage.child.stages));
    else out.push(stage);
  }
  return out;
}

function compileStage(stage: FlowStage, build: Build): WorkflowNode {
  switch (stage.kind) {
    case "step":
      return withId(childNode(stage.child, build), stage.id, build);
    case "switch": {
      const { default: fallback, ...cases } = stage.cases;
      const node: WorkflowNode = {
        switch: {
          cases: mapValues(cases, (child) => childNode(child, build)),
          ...(fallback === undefined ? {} : { default: childNode(fallback, build) }),
        },
      };
      return withId(node, stage.id, build);
    }
    case "parallel":
      return withId(
        { parallel: mapValues(stage.branches, (child) => childNode(child, build)) },
        stage.id,
        build
      );
    case "map":
      return withId({ map: { each: childNode(stage.each, build) } }, stage.id, build);
    case "loop":
      return withId(compileLoop(stage, build), stage.id, build);
  }
}

function compileLoop(stage: Extract<FlowStage, { kind: "loop" }>, build: Build): WorkflowNode {
  const label = stage.id ?? "loop";
  if (stage.max === undefined)
    build.diagnostics.push(
      diagnostic("loop.max-required", `Loop '${label}' needs { max } so it cannot run forever`)
    );
  else if (!Number.isInteger(stage.max) || stage.max < 1)
    build.diagnostics.push(
      diagnostic("loop.invalid-max", `Loop '${label}' max must be a positive integer`)
    );
  // The body first, so agents are embedded in the order they run.
  const run = childNode(stage.body, build);
  const verify = childNode(stage.verify, build);
  if (!("agent" in verify))
    build.diagnostics.push(
      diagnostic(
        "loop.invalid-verify",
        `Loop '${label}' verify must be a verifier agent, not a tool or flow()`
      )
    );
  return {
    loop: {
      run,
      verify: verify as Extract<WorkflowNode, { agent: string }>,
      max: Number.isInteger(stage.max) && (stage.max as number) > 0 ? (stage.max as number) : 1,
    },
  };
}

/** A stage child: an agent, tool, nested flow agent, `flow()` or `.withId()` child. */
function childNode(child: unknown, build: Build): WorkflowNode {
  if (isNamedChild(child)) return withId(childNode(child.run, build), child.id, build);
  if (isFlowBuilder(child)) {
    const stages = expand(child.stages);
    if (stages.length === 0) {
      build.diagnostics.push(diagnostic("flow.empty", "A flow() has no stages"));
      return { chain: [] };
    }
    if (stages.length === 1) return compileStage(stages[0]!, build);
    return { chain: stages.map((stage) => compileStage(stage, build)) };
  }
  if (isToolDefinition(child) && httpToolOf(child)) {
    build.diagnostics.push(
      diagnostic(
        "workflow.invalid-runnable",
        "An HTTP tool runs in an agent's tools, not as a flow stage"
      )
    );
    return { chain: [] };
  }
  if (isToolDefinition(child)) {
    const tool = bindToolNode(child);
    const node: WorkflowNode = toolManifestNode(tool);
    attach(build, node, { tool });
    return node;
  }
  if (child && typeof child === "object") {
    const built = builtOf(child);
    if (built && isBuiltWorkflow(built)) return nestedFlow(built, build);
    if (built) return agentLeaf(built as BuiltAgent, build);
  }
  build.diagnostics.push(
    diagnostic("workflow.invalid-runnable", "A flow stage needs an agent, a tool or a flow()")
  );
  return { chain: [] };
}

function builtOf(child: object): BuiltAgent | BuiltWorkflow | undefined {
  if (isBuiltWorkflow(child)) return child;
  if ("getBinding" in child && "manifest" in child) return child as BuiltAgent;
  if ("build" in child && typeof (child as { build: unknown }).build === "function")
    return (child as { build(): BuiltAgent | BuiltWorkflow }).build();
  return undefined;
}

function agentLeaf(agent: BuiltAgent, build: Build): WorkflowNode {
  const resolved = builtAgentOf(agent);
  embed(build, resolved.id, resolved.manifest);
  addBinding(build, resolved.id, bindingFromAgent(resolved));
  return { agent: resolved.id };
}

function nestedFlow(built: BuiltWorkflow, build: Build): WorkflowNode {
  const binding = built.getBinding();
  embed(build, built.id, built.manifest);
  for (const [id, agent] of Object.entries(binding.agents)) addBinding(build, id, agent);
  const node: WorkflowNode = { agent: built.id };
  attach(build, node, { nested: binding });
  return node;
}

function embed(build: Build, id: string, manifest: AgentManifest | WorkflowManifest): void {
  const existing = build.agents[id];
  if (existing === undefined) {
    build.agents[id] = manifest;
    return;
  }
  if (canonical(existing) !== canonical(manifest))
    build.diagnostics.push(
      diagnostic(
        "flow.agent-conflict",
        `Flow agent '${build.id}' uses two different agents with the id '${id}'. Give each agent its own id.`
      )
    );
}

function addBinding(build: Build, id: string, binding: AgentBinding): void {
  const existing = build.bindings[id];
  if (existing === undefined) build.bindings[id] = binding;
  else if (canonical(existing.manifest) !== canonical(binding.manifest))
    build.diagnostics.push(
      diagnostic(
        "flow.agent-conflict",
        `Flow agent '${build.id}' uses two different agents with the id '${id}'. Give each agent its own id.`
      )
    );
}

/** Put a stage's `id` on its node, wrapping it in a chain when it has its own. */
function withId(node: WorkflowNode, id: string | undefined, build: Build): WorkflowNode {
  if (id === undefined) return node;
  const clash = node.id !== undefined;
  const next = { ...(clash ? { chain: [node] } : node), id } as WorkflowNode;
  if (!clash) attach(build, next, build.code.get(node) ?? {});
  return next;
}

function attach(build: Build, node: object, code: NodeCode): void {
  const existing = build.code.get(node) ?? {};
  build.code.set(node, { ...existing, ...code });
}

/**
 * Walk the finished tree: check that leaves and stage ids are unique, and bind each
 * tool node's code under its stage key.
 */
function bindNodes(root: WorkflowNode, build: Build): Record<string, WorkflowNodeImplementation> {
  const nodes: Record<string, WorkflowNodeImplementation> = {};
  const leaves = new Set<string>();
  const ids = new Set<string>();
  forEachFlowNode(root, ({ node, key }) => {
    const part = leafPart(node);
    if (part !== undefined) {
      if (leaves.has(part) || ids.has(part))
        build.diagnostics.push(
          diagnostic(
            "flow.duplicate-leaf",
            `'${part}' runs twice in flow agent '${build.id}'. Give one a new id: x.withId("${part}-2").`
          )
        );
      leaves.add(part);
    } else if (node.id !== undefined) {
      if (ids.has(node.id) || leaves.has(node.id))
        build.diagnostics.push(
          diagnostic(
            "flow.duplicate-id",
            `Two stages of flow agent '${build.id}' are named '${node.id}'. Stage ids must be unique.`
          )
        );
      ids.add(node.id);
    }
    const code = build.code.get(node);
    if (!code) return;
    if (code.tool) nodes[key] = { kind: "tool", tool: code.tool };
    if (code.nested)
      for (const [inner, impl] of Object.entries(code.nested.nodes)) nodes[`${key}/${inner}`] = impl;
  });
  return nodes;
}

function jsonSchemaOf(source: ToolSchemaSource): JsonObject {
  return bindOutputContract(source).schema.jsonSchema as JsonObject;
}

function mapValues<T, U>(
  record: Readonly<Record<string, T>>,
  fn: (value: T, key: string) => U
): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [key, value] of Object.entries(record)) out[key] = fn(value, key);
  return out;
}
