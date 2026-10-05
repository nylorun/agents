import {
  ROOT_POSITION,
  childPosition,
  joinPath,
  leafPart,
  nodeKeyOf,
  stageKey,
  type WorkflowManifest,
  type WorkflowNode,
  type WorkflowTreeNode,
} from "./types.ts";

function leaf(
  path: string,
  kind: WorkflowTreeNode["kind"],
  label: string,
  extra: Partial<WorkflowTreeNode> = {},
): WorkflowTreeNode {
  return {
    path,
    key: nodeKeyOf(path),
    kind,
    layout: "leaf",
    label,
    children: [],
    ...extra,
  };
}

/**
 * Build a drawable tree from a workflow manifest v3 (workflows.md §11). Leaves are drawn at
 * their session paths (the paths `node.agent` and tool `action.*` events carry); control
 * stages at their stage keys (`route`, `@1`), which Loop events carry. A nested flow agent
 * is drawn inline under its own id. A chain is a row, a switch a fork, a parallel lanes, a map
 * one lane, and a loop its body and verifier agent, with its max.
 */
export function treeFromManifest(manifest: WorkflowManifest): WorkflowTreeNode {
  return walk(manifest, manifest.root, ROOT_POSITION, "");
}

function walk(
  flow: WorkflowManifest,
  node: WorkflowNode,
  position: string,
  prefix: string,
): WorkflowTreeNode {
  const key = stageKey(node, position, prefix);
  const part = leafPart(node);
  if ("agent" in node) {
    const embedded = flow.agents[node.agent] as
      | (WorkflowManifest & { readonly kind?: string })
      | undefined;
    if (embedded?.kind === "workflow")
      return {
        path: key,
        key,
        kind: "flow",
        layout: "row",
        label: part!,
        agentId: node.agent,
        children: [walk(embedded, embedded.root, ROOT_POSITION, key)],
      };
    return leaf(key, "agent", part!, { agentId: node.agent });
  }
  if ("tool" in node) return leaf(key, "tool", part!);
  const label = node.id ?? position;
  const wrap = (kind: "case" | "branch", name: string, child: WorkflowNode) => {
    const at = childPosition(position, name);
    const path = prefix ? `${prefix}/${at}` : at;
    return {
      path,
      key: path,
      kind,
      layout: "leaf" as const,
      label: name,
      children: [walk(flow, child, at, prefix)],
    };
  };
  if ("chain" in node)
    return {
      path: key,
      key,
      kind: "chain",
      layout: "row",
      label,
      children: node.chain.map((step, index) =>
        walk(flow, step, childPosition(position, index), prefix),
      ),
    };
  if ("switch" in node)
    return {
      path: key,
      key,
      kind: "switch",
      layout: "fork",
      label,
      children: [
        ...Object.entries(node.switch.cases).map(([name, child]) => wrap("case", name, child)),
        ...(node.switch.default ? [wrap("case", "default", node.switch.default)] : []),
      ],
    };
  if ("parallel" in node)
    return {
      path: key,
      key,
      kind: "parallel",
      layout: "lanes",
      label,
      children: Object.entries(node.parallel).map(([name, child]) => wrap("branch", name, child)),
    };
  if ("map" in node)
    return {
      path: key,
      key,
      kind: "map",
      layout: "map",
      label,
      children: [walk(flow, node.map.each, childPosition(position, "each"), prefix)],
    };
  if ("loop" in node)
    return {
      path: key,
      key,
      kind: "loop",
      layout: "loop",
      label: `${label} · max ${node.loop.max}`,
      children: [
        walk(flow, node.loop.run, childPosition(position, "run"), prefix),
        walk(flow, node.loop.verify, childPosition(position, "verify"), prefix),
      ],
    };
  throw new Error("Unknown workflow node");
}

/** Expand a Map node into indexed item lanes for drill-down. */
export function expandMapItems(
  mapNode: WorkflowTreeNode,
  count: number,
): readonly WorkflowTreeNode[] {
  if (mapNode.kind !== "map" || count < 0) return mapNode.children;
  const template = mapNode.children[0];
  if (!template) return [];
  const items: WorkflowTreeNode[] = [];
  for (let i = 0; i < count; i++) {
    const itemPath = `${mapNode.path}[${i}]`;
    items.push({
      path: itemPath,
      key: nodeKeyOf(itemPath),
      kind: "item",
      layout: "leaf",
      label: `[${i}]`,
      children: [rebasePath(template, mapNode.path, itemPath)],
    });
  }
  return items;
}

function rebasePath(
  node: WorkflowTreeNode,
  from: string,
  to: string,
): WorkflowTreeNode {
  const path =
    node.path === from
      ? to
      : node.path.startsWith(from + "/") || node.path.startsWith(from + "[")
        ? to + node.path.slice(from.length)
        : joinPath(to, node.label);
  return {
    ...node,
    path,
    key: nodeKeyOf(path),
    children: node.children.map((child) => rebasePath(child, from, to)),
  };
}
