/**
 * Compile a flow agent's stages to workflow manifest v2.
 *
 * Each stage becomes one node with optional `id` and `input`; leaf agents are
 * embedded in `agents`; user functions are bound under stage keys (`route:on`,
 * `@1.default.1:input`) and receive `{ input, results, flowInput }` from the engine
 * as written. Paths and keys follow `./paths.ts`.
 */
import type { JsonObject, BuildDiagnostic } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import type { AgentManifest } from "../../types/manifest.js";
import type { BuiltAgent } from "../../types/agent.js";
import { httpToolOf } from "../http-tool.js";
import type {
  WorkflowAgentNodeV2,
  WorkflowBinding,
  WorkflowManifestV2,
  WorkflowNodeImplementation,
  WorkflowNodeV2,
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
import { isFlowBuilder, isNamedChild, type FlowFn, type FlowStage } from "./spec.js";
import {
  forEachFlowNode,
  functionKey,
  isWorkflowManifestV2,
  leafPart,
} from "./paths.js";

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
  input?: FlowFn;
  on?: FlowFn;
  verify?: FlowFn;
  decide?: FlowFn;
  tool?: BoundToolDefinition;
  /** A nested flow agent: its bindings move under this node's key. */
  nested?: WorkflowBinding;
};

type Build = {
  readonly id: string;
  readonly code: WeakMap<object, NodeCode>;
  readonly agents: Record<string, AgentManifest | WorkflowManifestV2>;
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
        `Flow agent '${options.id}' has no stages. Add .step(), .switch(), .parallel(), .map() or .loop().`
      ),
    ]);
  const build: Build = {
    id: options.id,
    code: new WeakMap(),
    agents: {},
    bindings: {},
    diagnostics: [],
  };
  const root: WorkflowNodeV2 = { chain: stages.map((stage) => compileStage(stage, build)) };
  const nodes = bindNodes(root, build);
  if (build.diagnostics.length) fail(build.diagnostics);

  const manifest: WorkflowManifestV2 = {
    kind: "workflow",
    workflowSchemaVersion: 2,
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

/** Inline `.step(flow())` sequences that have no id or input into their parent. */
function expand(stages: readonly FlowStage[]): FlowStage[] {
  const out: FlowStage[] = [];
  for (const stage of stages) {
    if (
      stage.kind === "step" &&
      isFlowBuilder(stage.child) &&
      stage.id === undefined &&
      stage.input === undefined
    )
      out.push(...expand(stage.child.stages));
    else out.push(stage);
  }
  return out;
}

function compileStage(stage: FlowStage, build: Build): WorkflowNodeV2 {
  const options = { id: stage.id, input: stage.input };
  switch (stage.kind) {
    case "step":
      return withOptions(childNode(stage.child, build), options, build);
    case "switch": {
      const { default: fallback, ...cases } = stage.cases;
      const node: WorkflowNodeV2 = {
        switch: {
          on: { fn: true },
          cases: mapValues(cases, (child) => childNode(child, build)),
          ...(fallback === undefined ? {} : { default: childNode(fallback, build) }),
        },
      };
      attach(build, node, { on: stage.on });
      return withOptions(node, options, build);
    }
    case "parallel":
      return withOptions(
        { parallel: mapValues(stage.branches, (child) => childNode(child, build)) },
        options,
        build
      );
    case "map":
      return withOptions({ map: { each: childNode(stage.each, build) } }, options, build);
    case "loop":
      return withOptions(compileLoop(stage, build), options, build);
  }
}

function compileLoop(stage: Extract<FlowStage, { kind: "loop" }>, build: Build): WorkflowNodeV2 {
  const label = stage.id ?? "loop";
  if (stage.max !== undefined && (!Number.isInteger(stage.max) || stage.max < 1))
    build.diagnostics.push(
      diagnostic("loop.invalid-max", `Loop '${label}' max must be a positive integer`)
    );
  if (stage.max === undefined && stage.decide === undefined)
    build.diagnostics.push(
      diagnostic("loop.max-required", `Loop '${label}' needs { max } or { decide } so it cannot run forever`)
    );
  // The body first, so agents are embedded in the order they run.
  const run = childNode(stage.body, build);
  let verify: { readonly fn: true } | WorkflowAgentNodeV2 = { fn: true };
  const code: NodeCode = {};
  if (typeof stage.verify === "function") code.verify = stage.verify as FlowFn;
  else {
    const judge = childNode(stage.verify, build);
    if (!("agent" in judge)) {
      build.diagnostics.push(
        diagnostic(
          "loop.invalid-verify",
          `Loop '${label}' verify must be a function or an agent, not a tool or flow()`
        )
      );
    } else verify = judge;
  }
  if (stage.decide) code.decide = stage.decide;
  const node: WorkflowNodeV2 = {
    loop: {
      run,
      verify,
      ...(Number.isInteger(stage.max) && (stage.max as number) > 0 ? { max: stage.max } : {}),
      ...(stage.decide === undefined ? {} : { decide: { fn: true as const } }),
    },
  };
  attach(build, node, code);
  return node;
}

/** A stage child: an agent, tool, nested flow agent, `flow()` or `.withId()` child. */
function childNode(child: unknown, build: Build): WorkflowNodeV2 {
  if (isNamedChild(child))
    return withOptions(childNode(child.run, build), { id: child.id }, build);
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
    const node: WorkflowNodeV2 = toolManifestNode(tool);
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

function agentLeaf(agent: BuiltAgent, build: Build): WorkflowNodeV2 {
  const resolved = builtAgentOf(agent);
  embed(build, resolved.id, resolved.manifest);
  addBinding(build, resolved.id, bindingFromAgent(resolved));
  return { agent: resolved.id };
}

function nestedFlow(built: BuiltWorkflow, build: Build): WorkflowNodeV2 {
  if (!isWorkflowManifestV2(built.manifest)) {
    build.diagnostics.push(
      diagnostic(
        "flow.v1-workflow",
        `Workflow '${built.id}' was built with Chain, Switch, Parallel, Map or Loop, so it can't be a step of flow agent '${build.id}'. Write it as a flow agent: Agent({ id: "${built.id}" }).step(…).`
      )
    );
    return { chain: [] };
  }
  const binding = built.getBinding();
  embed(build, built.id, built.manifest);
  for (const [id, agent] of Object.entries(binding.agents)) addBinding(build, id, agent);
  const node: WorkflowNodeV2 = { agent: built.id };
  attach(build, node, { nested: binding });
  return node;
}

function embed(build: Build, id: string, manifest: AgentManifest | WorkflowManifestV2): void {
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

/** Put a stage's `id` and `input` on its node, wrapping it in a chain when it has its own. */
function withOptions(
  node: WorkflowNodeV2,
  options: { readonly id?: string; readonly input?: FlowFn },
  build: Build
): WorkflowNodeV2 {
  if (options.id === undefined && options.input === undefined) return node;
  const clash =
    (options.id !== undefined && node.id !== undefined) ||
    (options.input !== undefined && node.input !== undefined);
  const target: WorkflowNodeV2 = clash ? { chain: [node] } : node;
  const next = {
    ...target,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.input === undefined ? {} : { input: { fn: true as const } }),
  } as WorkflowNodeV2;
  const code = { ...(clash ? {} : build.code.get(node)) };
  if (options.input) code.input = options.input;
  attach(build, next, code);
  return next;
}

function attach(build: Build, node: object, code: NodeCode): void {
  const existing = build.code.get(node) ?? {};
  build.code.set(node, { ...existing, ...code });
}

/**
 * Walk the finished tree: check that leaves and stage ids are unique, and bind each
 * node's code under its stage key.
 */
function bindNodes(root: WorkflowNodeV2, build: Build): Record<string, WorkflowNodeImplementation> {
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
            `'${part}' runs twice in flow agent '${build.id}'. Give one a new id: .step(x, { id: "${part}-2" }) or x.withId("${part}-2").`
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
    if (code.input) nodes[functionKey(key, "input")] = { kind: "fn", fn: code.input as never };
    if (code.on) nodes[functionKey(key, "on")] = { kind: "fn", fn: code.on as never };
    if (code.verify) nodes[functionKey(key, "verify")] = { kind: "verify", fn: code.verify as never };
    if (code.decide) nodes[functionKey(key, "decide")] = { kind: "fn", fn: code.decide as never };
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
