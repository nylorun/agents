import type { AgentBinding } from "../definition/binding.js";
import type { BoundToolDefinition } from "../definition/bound.js";
import type { JsonObject, JsonValue } from "./shared.js";
import type { AgentManifest, SandboxManifest } from "./manifest.js";

/** Loop verify outcome: pass, or fail with required feedback. */
export type Verdict =
  | { readonly pass: true; readonly data?: JsonValue }
  | { readonly pass: false; readonly feedback: string; readonly data?: JsonValue };

/** Local function marker in a workflow manifest (code never crosses the wire). */
export interface WorkflowFnRef {
  readonly fn: true;
}

/** Agent leaf: referenced by definition id. */
export interface WorkflowAgentNode {
  readonly agent: string;
}

/** Tool leaf: name and schemas only; implementation stays in the binding. */
export interface WorkflowToolNode {
  readonly tool: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: JsonObject;
    readonly outputSchema?: JsonObject;
  };
}

export interface WorkflowChainNode {
  readonly chain: {
    readonly id: string;
    readonly steps: readonly WorkflowNode[];
  };
}

export interface WorkflowSwitchNode {
  readonly switch: {
    readonly id: string;
    readonly on: WorkflowFnRef;
    readonly cases: Readonly<Record<string, WorkflowNode>>;
    readonly default?: WorkflowNode;
  };
}

export interface WorkflowParallelNode {
  readonly parallel: {
    readonly id: string;
    readonly branches: Readonly<Record<string, WorkflowNode>>;
  };
}

export interface WorkflowMapNode {
  readonly map: {
    readonly id: string;
    readonly over: WorkflowFnRef;
    readonly each: WorkflowNode;
  };
}

export interface WorkflowLoopNode {
  readonly loop: {
    readonly id: string;
    readonly run: WorkflowNode;
    readonly verify: WorkflowFnRef | WorkflowAgentNode | WorkflowSlotNode;
    readonly decide: WorkflowFnRef;
  };
}

/** Rename and/or reshape a child: `{ slot: { id?, input?, run } }`. */
export interface WorkflowSlotNode {
  readonly slot: {
    readonly id?: string;
    readonly input?: WorkflowFnRef;
    readonly run: WorkflowNode;
  };
}

export type WorkflowNode =
  | WorkflowAgentNode
  | WorkflowToolNode
  | WorkflowChainNode
  | WorkflowSwitchNode
  | WorkflowParallelNode
  | WorkflowMapNode
  | WorkflowLoopNode
  | WorkflowSlotNode;

/** Workflow manifest v1: control nodes carry ids, and agents are resolved from the registry. */
export interface WorkflowManifestV1 {
  readonly kind: "workflow";
  readonly workflowSchemaVersion: 1;
  readonly id: string;
  readonly root: WorkflowNode;
  readonly sandbox?: SandboxManifest;
}

// ── Workflow manifest v2 (Flow Agents) ──────────────────────────────────────

/**
 * Fields every v2 node may carry. `id` names the stage: for an agent or tool it
 * replaces the leaf's path part, for a control node it is the stage key and the
 * `results` key. `input` marks a function that reshapes what the node receives.
 */
export interface WorkflowNodeOptionsV2 {
  readonly id?: string;
  readonly input?: WorkflowFnRef;
}

/** Agent leaf, or a nested flow agent: a key of the enclosing manifest's `agents`. */
export interface WorkflowAgentNodeV2 extends WorkflowNodeOptionsV2 {
  readonly agent: string;
}

export interface WorkflowToolNodeV2 extends WorkflowNodeOptionsV2 {
  readonly tool: WorkflowToolNode["tool"];
}

export interface WorkflowChainNodeV2 extends WorkflowNodeOptionsV2 {
  readonly chain: readonly WorkflowNodeV2[];
}

export interface WorkflowSwitchNodeV2 extends WorkflowNodeOptionsV2 {
  readonly switch: {
    readonly on: WorkflowFnRef;
    readonly cases: Readonly<Record<string, WorkflowNodeV2>>;
    readonly default?: WorkflowNodeV2;
  };
}

export interface WorkflowParallelNodeV2 extends WorkflowNodeOptionsV2 {
  readonly parallel: Readonly<Record<string, WorkflowNodeV2>>;
}

/** Runs `each` once per item of its input, which must be an array. */
export interface WorkflowMapNodeV2 extends WorkflowNodeOptionsV2 {
  readonly map: { readonly each: WorkflowNodeV2 };
}

/**
 * Runs `run`, judges it with `verify`, then retries or stops. Without `decide`, a pass
 * returns the output and a fail retries with the feedback, up to `max` attempts.
 */
export interface WorkflowLoopNodeV2 extends WorkflowNodeOptionsV2 {
  readonly loop: {
    readonly run: WorkflowNodeV2;
    readonly verify: WorkflowFnRef | WorkflowAgentNodeV2;
    readonly max?: number;
    readonly decide?: WorkflowFnRef;
  };
}

export type WorkflowNodeV2 =
  | WorkflowAgentNodeV2
  | WorkflowToolNodeV2
  | WorkflowChainNodeV2
  | WorkflowSwitchNodeV2
  | WorkflowParallelNodeV2
  | WorkflowMapNodeV2
  | WorkflowLoopNodeV2;

/**
 * Workflow manifest v2: a flow agent. Its leaf agents are embedded in `agents`, so one
 * manifest hash covers the whole agent, and session paths come from the leaves.
 */
export interface WorkflowManifestV2 {
  readonly kind: "workflow";
  readonly workflowSchemaVersion: 2;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly inputSchema?: JsonObject;
  readonly outputSchema?: JsonObject;
  /** The sandbox every leaf that declares one shares. */
  readonly sandbox?: SandboxManifest;
  readonly root: WorkflowNodeV2;
  /** Every agent the flow runs, by id: ReAct agents (v4) and nested flow agents (v2). */
  readonly agents: Readonly<Record<string, AgentManifest | WorkflowManifestV2>>;
}

/** Wire document for a workflow definition. Missing `kind` is never a workflow. */
export type WorkflowManifest = WorkflowManifestV1 | WorkflowManifestV2;

/**
 * Local implementation for a node key: a tool node, a pure `fn`, or a Loop `verify` function.
 * Functions are never serialized.
 */
export type WorkflowNodeImplementation =
  | { readonly kind: "tool"; readonly tool: BoundToolDefinition }
  | { readonly kind: "fn"; readonly fn: (...args: never[]) => unknown }
  | { readonly kind: "verify"; readonly fn: (...args: never[]) => unknown };

/**
 * Built-workflow binding: manifest plus node-key → implementation, and referenced agent bindings.
 * Not a wire format; `toJSON()` stays manifest-only.
 */
export interface WorkflowBinding {
  readonly manifest: WorkflowManifest;
  /** Node key (path without Map indices) → local code. */
  readonly nodes: Readonly<Record<string, WorkflowNodeImplementation>>;
  readonly agents: Readonly<Record<string, AgentBinding>>;
}
