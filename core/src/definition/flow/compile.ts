/**
 * Compile a flow agent's stages to workflow manifest v3.
 *
 * Each stage becomes one node with an optional `id`; leaf agents are embedded in
 * `agents`; tool nodes are bound under their stage keys, except HTTP stages, which carry
 * their `http` target and bind nothing. Paths and keys follow `./paths.ts`.
 */
import type { JsonObject, BuildDiagnostic } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import type { AgentManifest } from "../../types/manifest.js";
import type { BuiltAgent } from "../../types/agent.js";
import { httpToolOf, isHttpTarget } from "../http-tool.js";
import type {
  WorkflowBinding,
  WorkflowLoopVerify,
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
import { forEachFlowNode, isWorkflowManifest, leafPart } from "./paths.js";

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
  checkHttpInputs(root, build, options.inputSchema && jsonSchemaOf(options.inputSchema));
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
  return {
    loop: {
      run,
      verify: verifyNode(stage.verify, label, build),
      max: Number.isInteger(stage.max) && (stage.max as number) > 0 ? (stage.max as number) : 1,
    },
  };
}

/** A Loop's verifier: a verifier agent, or an HTTP verifier (`http({ url })`). */
function verifyNode(verify: unknown, label: string, build: Build): WorkflowLoopVerify {
  if (isHttpTarget(verify)) return { http: { ...verify.http } };
  const node = isToolDefinition(verify) && httpToolOf(verify) ? undefined : childNode(verify, build);
  if (node && "agent" in node) return node;
  build.diagnostics.push(
    diagnostic(
      "loop.invalid-verify",
      node
        ? `Loop '${label}' verify must be a verifier agent or an HTTP verifier, http({ url }), not a tool or flow()`
        : `Loop '${label}' verify takes an HTTP verifier, http({ url }) with no name or input, not an HTTP tool`
    )
  );
  return { agent: "" };
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
  if (isToolDefinition(child)) {
    const tool = bindToolNode(child);
    const node = toolManifestNode(tool);
    const target = httpToolOf(child);
    if (!target) {
      attach(build, node, { tool });
      return node;
    }
    if (target.approval === "always")
      build.diagnostics.push(
        diagnostic(
          "flow.approval-unsupported",
          `HTTP stage '${tool.name}': approval on a flow stage is not supported yet`
        )
      );
    // The Runtime runs it through its Tool Gate: nothing is bound.
    return { tool: { ...node.tool, http: { ...target.http } } };
  }
  if (isHttpTarget(child)) {
    build.diagnostics.push(
      diagnostic(
        "workflow.invalid-runnable",
        "http({ url }) without a name and an input is a Loop verifier; an HTTP stage needs http({ name, input, url })"
      )
    );
    return { chain: [] };
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
    } else if ("id" in node && node.id !== undefined) {
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

const TYPE_NAMES: Readonly<Record<string, string>> = {
  string: "text",
  array: "a list",
  object: "an object",
  number: "a number",
  integer: "a number",
  boolean: "a boolean",
  null: "null",
};

/**
 * Refuse an HTTP stage whose input is known at build time to be of the wrong JSON type: the
 * stage before it returns text (an agent with no output schema), a list (a Map), or a schema of
 * another type, or the flow's input schema does. Anything else is checked when the stage runs.
 */
function checkHttpInputs(root: WorkflowNode, build: Build, flowInput: JsonObject | undefined): void {
  const check = (node: WorkflowNode, before: { type?: string; what: string; hint?: string }) => {
    const first = firstStage(node);
    if (!("tool" in first) || !first.tool.http) return;
    const wanted = first.tool.inputSchema?.type;
    if (typeof wanted !== "string" || before.type === undefined || before.type === wanted) return;
    const takes = TYPE_NAMES[wanted] ?? wanted;
    const returns = TYPE_NAMES[before.type] ?? before.type;
    build.diagnostics.push(
      diagnostic(
        "flow.input-mismatch",
        `HTTP stage '${first.tool.name}' takes ${takes} (its input schema), but ${before.what} returns ${returns}${before.hint ?? ""}`
      )
    );
  };
  if ("chain" in root && root.chain.length > 0) {
    const type = flowInput?.type;
    if (typeof type === "string") check(root.chain[0]!, { type, what: "the flow's input schema" });
  }
  forEachFlowNode(root, ({ node }) => {
    if (!("chain" in node)) return;
    node.chain.forEach((step, index) => {
      if (index > 0) check(step, outputOf(node.chain[index - 1]!, build));
    });
  });
}

/** The stage that gets a node's input. */
function firstStage(node: WorkflowNode): WorkflowNode {
  return "chain" in node && node.chain.length > 0 ? firstStage(node.chain[0]!) : node;
}

/** What is known at build time of a node's output: its JSON type, if any. */
function outputOf(node: WorkflowNode, build: Build): { type?: string; what: string; hint?: string } {
  if ("chain" in node && node.chain.length > 0) return outputOf(node.chain.at(-1)!, build);
  if ("map" in node) return { type: "array", what: "the Map before it" };
  if ("parallel" in node) return { type: "object", what: "the Parallel before it" };
  const typeOf = (schema: JsonObject | undefined) =>
    typeof schema?.type === "string" ? { type: schema.type } : {};
  if ("tool" in node) return { ...typeOf(node.tool.outputSchema), what: `tool '${node.tool.name}'` };
  if ("agent" in node) {
    const agent = build.agents[node.agent];
    const what = `agent '${node.agent}'`;
    if (!agent) return { what };
    if (agent.outputSchema || isWorkflowManifest(agent as WorkflowManifest))
      return { ...typeOf(agent.outputSchema), what };
    return { type: "string", what, hint: `: give '${node.agent}' an .output() schema` };
  }
  return { what: "the stage before it" };
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
