import type { AgentBinding } from "../definition/binding.js";
import type { BoundToolDefinition } from "../definition/bound.js";
import type { JsonObject, JsonValue } from "./shared.js";
import type { AgentManifest, SandboxManifest } from "./manifest.js";

/** Loop verify outcome: pass, or fail with required feedback. */
export type Verdict =
  | { readonly pass: true; readonly data?: JsonValue }
  | { readonly pass: false; readonly feedback: string; readonly data?: JsonValue };

/**
 * Workflow manifest v3 (flow agents). A flow is data: no node names developer code. Each
 * stage gets the previous stage's output, and the first stage gets the flow's input.
 *
 * Every node may carry `id`. For an agent or tool it replaces the leaf's path part; for a
 * control node it is the stage key.
 */
export interface WorkflowNodeOptions {
  readonly id?: string;
}

/** Agent leaf, or a nested flow agent: a key of the enclosing manifest's `agents`. */
export interface WorkflowAgentNode extends WorkflowNodeOptions {
  readonly agent: string;
}

/** Tool leaf: name and schemas only; the implementation is served by the Action endpoint. */
export interface WorkflowToolNode extends WorkflowNodeOptions {
  readonly tool: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: JsonObject;
    readonly outputSchema?: JsonObject;
  };
}

export interface WorkflowChainNode extends WorkflowNodeOptions {
  readonly chain: readonly WorkflowNode[];
}

/**
 * Picks a case from the previous output: a string is the case name, and so is an object's
 * `route` field. The chosen case gets the whole output; `default` catches the rest.
 */
export interface WorkflowSwitchNode extends WorkflowNodeOptions {
  readonly switch: {
    readonly cases: Readonly<Record<string, WorkflowNode>>;
    readonly default?: WorkflowNode;
  };
}

/** Every branch gets the same input; the output is keyed by branch. */
export interface WorkflowParallelNode extends WorkflowNodeOptions {
  readonly parallel: Readonly<Record<string, WorkflowNode>>;
}

/** Runs `each` once per item of its input: an array, or an object's `items` array. */
export interface WorkflowMapNode extends WorkflowNodeOptions {
  readonly map: { readonly each: WorkflowNode };
}

/** What judges a Loop attempt: a verifier agent. */
export type WorkflowLoopVerify = WorkflowAgentNode;

/**
 * Runs `run`, judges it with `verify`, then stops on a pass or retries with the verdict's
 * feedback, up to `max` attempts.
 */
export interface WorkflowLoopNode extends WorkflowNodeOptions {
  readonly loop: {
    readonly run: WorkflowNode;
    readonly verify: WorkflowLoopVerify;
    readonly max: number;
  };
}

export type WorkflowNode =
  | WorkflowAgentNode
  | WorkflowToolNode
  | WorkflowChainNode
  | WorkflowSwitchNode
  | WorkflowParallelNode
  | WorkflowMapNode
  | WorkflowLoopNode;

/**
 * Workflow manifest v3: a flow agent. Its leaf agents are embedded in `agents`, so one
 * manifest hash covers the whole agent, and session paths come from the leaves.
 */
export interface WorkflowManifest {
  readonly kind: "workflow";
  readonly workflowSchemaVersion: 3;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly inputSchema?: JsonObject;
  readonly outputSchema?: JsonObject;
  /** The sandbox every leaf that declares one shares. */
  readonly sandbox?: SandboxManifest;
  readonly root: WorkflowNode;
  /** Every agent the flow runs, by id: ReAct agents (v5) and nested flow agents (v3). */
  readonly agents: Readonly<Record<string, AgentManifest | WorkflowManifest>>;
}

/** Local implementation for a tool node key. Never serialized. */
export type WorkflowNodeImplementation = {
  readonly kind: "tool";
  readonly tool: BoundToolDefinition;
};

/**
 * Built-workflow binding: manifest plus tool node key → implementation, and embedded agent
 * bindings. Not a wire format; `toJSON()` stays manifest-only.
 */
export interface WorkflowBinding {
  readonly manifest: WorkflowManifest;
  /** Tool node key (path without Map indices) → local code. */
  readonly nodes: Readonly<Record<string, WorkflowNodeImplementation>>;
  readonly agents: Readonly<Record<string, AgentBinding>>;
}
