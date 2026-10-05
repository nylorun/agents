/**
 * Paths and keys for workflow manifest v3 (flow agents). Shared by the compiler, the
 * flow engine, the executor and Studio, so every package names a node the same way.
 *
 * - A **leaf path** names an agent or tool session: the leaf's id (its `id`, or the
 *   agent's id or tool name), with `[i]` for each Map item it runs in, under the ids of
 *   any nested flow agents. Control stages and `flow()` add nothing, so wrapping a step
 *   in a Loop or moving it out of a Switch keeps its session.
 * - A **stage key** names a node: a leaf's id, a control stage's `id`, or else its
 *   position from the flow root (`@1.default.1`). A tool node's code is bound under its key, and
 *   the Runtime finds an HTTP stage or an HTTP verifier by it.
 */
import type {
  WorkflowAgentNode,
  WorkflowHttpVerify,
  WorkflowManifest,
  WorkflowNode,
  WorkflowToolNode,
} from "../../types/workflow.js";
import type { AgentManifest, HttpToolTarget } from "../../types/manifest.js";
import type { JsonObject } from "../../types/shared.js";

/** A node the walk visits: a stage, or a Loop's HTTP verifier. */
export type FlowVisitNode = WorkflowNode | WorkflowHttpVerify;

/** Position of a flow's root node. */
export const ROOT_POSITION = "@";

/** True for a workflow manifest v3: a flow agent, or a nested one among `agents`. */
export function isWorkflowManifest(
  manifest: { readonly kind?: unknown; readonly workflowSchemaVersion?: unknown } | undefined
): manifest is WorkflowManifest {
  return manifest?.kind === "workflow" && manifest.workflowSchemaVersion === 3;
}

export function isLeafNode(
  node: WorkflowNode
): node is WorkflowAgentNode | WorkflowToolNode {
  return "agent" in node || "tool" in node;
}

/** A leaf's path part: its `id`, else the agent id or tool name. Undefined for control nodes. */
export function leafPart(node: FlowVisitNode): string | undefined {
  if ("agent" in node) return node.id ?? node.agent;
  if ("tool" in node) return node.id ?? node.tool.name;
  return undefined;
}

/** The position of a child: `@` + index for the root's children, else `parent.segment`. */
export function childPosition(parent: string, segment: string | number): string {
  return parent === ROOT_POSITION ? `${ROOT_POSITION}${segment}` : `${parent}.${segment}`;
}

/**
 * A node's stage key: a leaf's path part, a control node's `id`, or its position.
 * `prefix` is the key of the nested flow agent the node runs in, if any.
 */
export function stageKey(node: FlowVisitNode, position: string, prefix = ""): string {
  const own = leafPart(node) ?? ("id" in node ? node.id : undefined) ?? position;
  return prefix ? `${prefix}/${own}` : own;
}

/** `[0][2]` for Map item indices, outermost first. */
export function indexSuffix(indices: readonly number[]): string {
  return indices.map((index) => `[${index}]`).join("");
}

/** A leaf's session path: `prefix/part[i]…`. */
export function leafPath(prefix: string, part: string, indices: readonly number[] = []): string {
  const own = `${part}${indexSuffix(indices)}`;
  return prefix ? `${prefix}/${own}` : own;
}

/** Drop Map indices from a path: the key a tool node's code is bound under. */
export function stripIndices(path: string): string {
  return path.replace(/\[\d+]/g, "");
}

export interface FlowNodeVisit {
  readonly node: FlowVisitNode;
  readonly position: string;
  /** Stage key, including the nested flow agent prefix. */
  readonly key: string;
  /** How the node sits in its parent: `step`, `case`, `default`, `branch`, `each`, `run` or `verify`. */
  readonly role: "root" | "step" | "case" | "default" | "branch" | "each" | "run" | "verify";
  /** True when an enclosing Map runs this node once per item. */
  readonly inMap: boolean;
}

/**
 * Visit every node of one flow, parents first. Nested flow agents are not entered:
 * their nodes live in their own manifest under `agents`.
 */
export function forEachFlowNode(
  root: WorkflowNode,
  visit: (entry: FlowNodeVisit) => void,
  options: { readonly prefix?: string } = {}
): void {
  const prefix = options.prefix ?? "";
  const walk = (
    node: FlowVisitNode,
    position: string,
    role: FlowNodeVisit["role"],
    inMap: boolean
  ): void => {
    visit({ node, position, key: stageKey(node, position, prefix), role, inMap });
    if ("chain" in node)
      node.chain.forEach((child, index) =>
        walk(child, childPosition(position, index), "step", inMap)
      );
    else if ("switch" in node) {
      for (const [name, child] of Object.entries(node.switch.cases))
        walk(child, childPosition(position, name), "case", inMap);
      if (node.switch.default)
        walk(node.switch.default, childPosition(position, "default"), "default", inMap);
    } else if ("parallel" in node) {
      for (const [name, child] of Object.entries(node.parallel))
        walk(child, childPosition(position, name), "branch", inMap);
    } else if ("map" in node) walk(node.map.each, childPosition(position, "each"), "each", true);
    else if ("loop" in node) {
      walk(node.loop.run, childPosition(position, "run"), "run", inMap);
      walk(node.loop.verify, childPosition(position, "verify"), "verify", inMap);
    }
  };
  walk(root, ROOT_POSITION, "root", false);
}

/** What the Runtime needs of an HTTP stage or an HTTP verifier. */
export interface FlowHttpTarget {
  readonly http: HttpToolTarget;
  /** An HTTP stage's output schema; a verifier's answer is checked as a verdict instead. */
  readonly outputSchema?: JsonObject;
  /** True for a Loop's HTTP verifier. */
  readonly verify: boolean;
}

/**
 * The HTTP stage or HTTP verifier of `manifest` at stage key `key`, looking through nested
 * flow agents (`outer/inner`), or undefined.
 */
export function flowHttpTarget(manifest: WorkflowManifest, key: string): FlowHttpTarget | undefined {
  let found: FlowHttpTarget | undefined;
  const search = (flow: WorkflowManifest, prefix: string): void =>
    forEachFlowNode(
      flow.root,
      ({ node, key: at, role }) => {
        if (found) return;
        if (at === key && "http" in node) found = { http: node.http, verify: role === "verify" };
        else if (at === key && "tool" in node && node.tool.http)
          found = {
            http: node.tool.http,
            ...(node.tool.outputSchema === undefined ? {} : { outputSchema: node.tool.outputSchema }),
            verify: false,
          };
        else if ("agent" in node && key.startsWith(`${at}/`)) {
          const nested = flow.agents[node.agent];
          if (isWorkflowManifest(nested as WorkflowManifest | undefined))
            search(nested as WorkflowManifest, at);
        }
      },
      { prefix }
    );
  search(manifest, "");
  return found;
}

/**
 * The embedded agent an agent node names, looked up through the nested flow agents
 * (`flow`, outermost first) the node runs in.
 */
export function embeddedAgent(
  manifest: WorkflowManifest,
  flow: readonly string[],
  agentId: string
): AgentManifest | WorkflowManifest | undefined {
  let scope = manifest;
  for (const id of flow) {
    const next = scope.agents[id];
    if (!isWorkflowManifest(next as WorkflowManifest | undefined)) return undefined;
    scope = next as WorkflowManifest;
  }
  return scope.agents[agentId];
}
