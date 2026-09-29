import {
  ROOT_POSITION,
  childPosition,
  joinPath,
  leafPart,
  nodeKeyOf,
  stageKey,
  type WorkflowManifest,
  type WorkflowManifestV2,
  type WorkflowNode,
  type WorkflowNodeV2,
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

function partId(node: WorkflowNode): string | undefined {
  if ("agent" in node) return node.agent;
  if ("tool" in node) return node.tool.name;
  if ("chain" in node) return node.chain.id;
  if ("switch" in node) return node.switch.id;
  if ("parallel" in node) return node.parallel.id;
  if ("map" in node) return node.map.id;
  if ("loop" in node) return node.loop.id;
  if ("slot" in node) return node.slot.id ?? partId(node.slot.run);
  return undefined;
}

function walk(
  node: WorkflowNode,
  parentPath: string,
  partOverride?: string,
): WorkflowTreeNode {
  if ("slot" in node) {
    // Slot id renames the child path part (workflows.md §4 / §6).
    return walk(node.slot.run, parentPath, node.slot.id ?? partOverride);
  }
  if ("agent" in node) {
    const part = partOverride ?? node.agent;
    const path = joinPath(parentPath, part);
    return leaf(path, "agent", part, { agentId: node.agent });
  }
  if ("tool" in node) {
    const part = partOverride ?? node.tool.name;
    const path = joinPath(parentPath, part);
    return leaf(path, "tool", part);
  }
  if ("chain" in node) {
    const part = partOverride ?? node.chain.id;
    const path = joinPath(parentPath, part);
    return {
      path,
      key: nodeKeyOf(path),
      kind: "chain",
      layout: "row",
      label: part,
      children: node.chain.steps.map((step) => walk(step, path)),
    };
  }
  if ("switch" in node) {
    const part = partOverride ?? node.switch.id;
    const path = joinPath(parentPath, part);
    const cases = Object.entries(node.switch.cases).map(([name, child]) => {
      const casePath = joinPath(path, name);
      return {
        path: casePath,
        key: nodeKeyOf(casePath),
        kind: "case" as const,
        layout: "leaf" as const,
        label: name,
        children: [walk(child, casePath)],
      };
    });
    if (node.switch.default) {
      const casePath = joinPath(path, "default");
      cases.push({
        path: casePath,
        key: nodeKeyOf(casePath),
        kind: "case",
        layout: "leaf",
        label: "default",
        children: [walk(node.switch.default, casePath)],
      });
    }
    return {
      path,
      key: nodeKeyOf(path),
      kind: "switch",
      layout: "fork",
      label: part,
      children: cases,
    };
  }
  if ("parallel" in node) {
    const part = partOverride ?? node.parallel.id;
    const path = joinPath(parentPath, part);
    return {
      path,
      key: nodeKeyOf(path),
      kind: "parallel",
      layout: "lanes",
      label: part,
      children: Object.entries(node.parallel.branches).map(([name, child]) => {
        const branchPath = joinPath(path, name);
        return {
          path: branchPath,
          key: nodeKeyOf(branchPath),
          kind: "branch" as const,
          layout: "leaf" as const,
          label: name,
          children: [walk(child, branchPath)],
        };
      }),
    };
  }
  if ("map" in node) {
    const part = partOverride ?? node.map.id;
    const path = joinPath(parentPath, part);
    return {
      path,
      key: nodeKeyOf(path),
      kind: "map",
      layout: "map",
      label: part,
      children: [walk(node.map.each, path)],
    };
  }
  if ("loop" in node) {
    const part = partOverride ?? node.loop.id;
    const path = joinPath(parentPath, part);
    const run = walk(node.loop.run, path);
    const verify =
      "fn" in node.loop.verify
        ? leaf(path, "fn", "verify")
        : walk(node.loop.verify, path);
    const decide = leaf(joinPath(path, "decide"), "fn", "decide");
    return {
      path,
      key: nodeKeyOf(path),
      kind: "loop",
      layout: "loop",
      label: part,
      children: [run, verify, decide],
    };
  }
  throw new Error("Unknown workflow node");
}

/**
 * Build a drawable tree from a workflow manifest (workflows.md §11).
 * Chain → row, Switch → fork, Parallel → lanes, Map → one lane, Loop → iteration badge host.
 */
export function treeFromManifest(manifest: WorkflowManifest): WorkflowTreeNode {
  if (manifest.workflowSchemaVersion === 2) return walkV2(manifest, manifest.root, ROOT_POSITION, "");
  return walk(manifest.root, "");
}

/**
 * v2: leaves are drawn at their session paths (the paths `node.agent` and tool
 * `action.*` events carry); control stages at their stage keys (`route`, `@1`), which
 * Loop events carry. A nested flow agent is drawn inline under its own id.
 */
function walkV2(
  flow: WorkflowManifestV2,
  node: WorkflowNodeV2,
  position: string,
  prefix: string,
): WorkflowTreeNode {
  const key = stageKey(node, position, prefix);
  const part = leafPart(node);
  if ("agent" in node) {
    const embedded = flow.agents[node.agent] as
      | (WorkflowManifestV2 & { readonly kind?: string })
      | undefined;
    if (embedded?.kind === "workflow" && embedded.workflowSchemaVersion === 2)
      return {
        path: key,
        key,
        kind: "flow",
        layout: "row",
        label: part!,
        agentId: node.agent,
        children: [walkV2(embedded, embedded.root, ROOT_POSITION, key)],
      };
    return leaf(key, "agent", part!, { agentId: node.agent });
  }
  if ("tool" in node) return leaf(key, "tool", part!);
  const label = node.id ?? position;
  const wrap = (kind: "case" | "branch", name: string, child: WorkflowNodeV2) => {
    const at = childPosition(position, name);
    const path = prefix ? `${prefix}/${at}` : at;
    return {
      path,
      key: path,
      kind,
      layout: "leaf" as const,
      label: name,
      children: [walkV2(flow, child, at, prefix)],
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
        walkV2(flow, step, childPosition(position, index), prefix),
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
      children: [walkV2(flow, node.map.each, childPosition(position, "each"), prefix)],
    };
  if ("loop" in node) {
    const verify = node.loop.verify;
    return {
      path: key,
      key,
      kind: "loop",
      layout: "loop",
      label: node.loop.max === undefined ? label : `${label} · max ${node.loop.max}`,
      children: [
        walkV2(flow, node.loop.run, childPosition(position, "run"), prefix),
        "agent" in verify
          ? walkV2(flow, verify, childPosition(position, "verify"), prefix)
          : leaf(`${key}:verify`, "fn", "verify"),
        ...(node.loop.decide ? [leaf(`${key}:decide`, "fn", "decide")] : []),
      ],
    };
  }
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

export { partId };
