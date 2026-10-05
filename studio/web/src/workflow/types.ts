/** Wire shapes for workflow manifests and seam events (studio-local; no core package import). */

/** Workflow manifest v3 (flow agents): `id` on any node, embedded agents, no functions. */
export type WorkflowNodeOptions = { readonly id?: string };
export type WorkflowAgentNode = WorkflowNodeOptions & { readonly agent: string };
export type WorkflowToolNode = WorkflowNodeOptions & {
  readonly tool: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
  };
};
export type WorkflowNode =
  | WorkflowAgentNode
  | WorkflowToolNode
  | (WorkflowNodeOptions & { readonly chain: readonly WorkflowNode[] })
  | (WorkflowNodeOptions & {
      readonly switch: {
        readonly cases: Readonly<Record<string, WorkflowNode>>;
        readonly default?: WorkflowNode;
      };
    })
  | (WorkflowNodeOptions & { readonly parallel: Readonly<Record<string, WorkflowNode>> })
  | (WorkflowNodeOptions & { readonly map: { readonly each: WorkflowNode } })
  | (WorkflowNodeOptions & {
      readonly loop: {
        readonly run: WorkflowNode;
        readonly verify: WorkflowAgentNode;
        readonly max: number;
      };
    });

export type WorkflowManifest = {
  readonly kind: "workflow";
  readonly workflowSchemaVersion: 3;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly root: WorkflowNode;
  readonly agents: Readonly<Record<string, { readonly id: string; readonly kind?: string }>>;
  readonly sandbox?: unknown;
};

/** How Studio lays out a control node (workflows.md §11). */
export type TreeLayout = "row" | "fork" | "lanes" | "map" | "loop" | "leaf";

export type TreeNodeKind =
  | "agent"
  | "tool"
  | "chain"
  | "switch"
  | "parallel"
  | "map"
  | "loop"
  | "case"
  | "branch"
  | "item"
  | "flow";

export type WorkflowTreeNode = {
  readonly path: string;
  readonly key: string;
  readonly kind: TreeNodeKind;
  readonly layout: TreeLayout;
  readonly label: string;
  /** Agent definition id when kind is agent. */
  readonly agentId?: string;
  readonly children: readonly WorkflowTreeNode[];
};

export type NodeRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "waiting"
  | "selected";

export type NodeLiveState = {
  readonly status: NodeRunStatus;
  readonly iterations?: string;
  readonly iteration?: number;
  readonly mapCount?: number;
  readonly selectedCase?: string;
  readonly agentSessionId?: string;
  readonly agentTurnId?: string;
  readonly error?: { readonly code: string; readonly message: string };
};

/** agentSessionId → workflow ownership (Runtime links index shape). */
export type WorkflowLink = {
  readonly workflowSessionId: string;
  readonly path: string;
  readonly workflowAgentId?: string;
};

export type IterationRecord = {
  readonly n: number;
  readonly path: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly manifestHash?: string;
  readonly waiting?: boolean;
  readonly pass?: boolean;
  readonly feedback?: string;
};

export type EventLike = {
  readonly type: string;
  readonly payload?: unknown;
  readonly sessionId?: string;
};

export function isWorkflowManifest(value: unknown): value is WorkflowManifest {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "workflow" &&
    typeof (value as { id?: unknown }).id === "string" &&
    (value as { root?: unknown }).root !== undefined
  );
}

export function joinPath(parent: string, part: string): string {
  return parent ? `${parent}/${part}` : part;
}

export function nodeKeyOf(path: string): string {
  return path.replace(/\[\d+]/g, "");
}

// Paths and keys. Studio's bundle can't import core, so these mirror
// `core/src/definition/flow/paths.ts`; `scripts/workflow-tree.test.mjs` pins them.

/** Position of a flow's root node. */
export const ROOT_POSITION = "@";

export function childPosition(parent: string, segment: string | number): string {
  return parent === ROOT_POSITION ? `${ROOT_POSITION}${segment}` : `${parent}.${segment}`;
}

/** A leaf's path part: its `id`, else the agent id or tool name. */
export function leafPart(node: WorkflowNode): string | undefined {
  if ("agent" in node) return node.id ?? node.agent;
  if ("tool" in node) return node.id ?? node.tool.name;
  return undefined;
}

/** A node's stage key: a leaf's path part, a control node's `id`, or its position. */
export function stageKey(node: WorkflowNode, position: string, prefix = ""): string {
  const own = leafPart(node) ?? node.id ?? position;
  return prefix ? `${prefix}/${own}` : own;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function payloadOf(event: EventLike): Readonly<Record<string, unknown>> {
  return record(event.payload);
}
