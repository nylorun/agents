import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  expandMapItems,
  statusColor,
  type NodeLiveState,
  type WorkflowTreeNode,
} from "@/workflow";
import { cn } from "@/lib/utils";
import { sessionHref } from "@/session-open";

function NodeBadge({
  node,
  live,
}: Readonly<{ node: WorkflowTreeNode; live?: NodeLiveState }>) {
  if (node.layout === "loop" && live?.iteration !== undefined)
    return (
      <Badge variant="outline" className="font-mono text-[10px]">
        iter {live.iteration}
      </Badge>
    );
  if (node.layout === "map" && live?.mapCount !== undefined)
    return (
      <Badge variant="outline" className="font-mono text-[10px]">
        ×{live.mapCount}
      </Badge>
    );
  if (node.layout === "fork" && live?.selectedCase)
    return (
      <Badge variant="outline" className="font-mono text-[10px]">
        → {live.selectedCase}
      </Badge>
    );
  return null;
}

function TreeBranch({
  node,
  liveByPath,
  selectedPath,
  onSelect,
  depth = 0,
}: Readonly<{
  node: WorkflowTreeNode;
  liveByPath: ReadonlyMap<string, NodeLiveState>;
  selectedPath?: string;
  onSelect?: (node: WorkflowTreeNode) => void;
  depth?: number;
}>) {
  const live = liveByPath.get(node.path);
  const color = statusColor(live?.status ?? "idle");
  const children =
    node.kind === "map" && live?.mapCount !== undefined && live.mapCount > 0
      ? expandMapItems(node, live.mapCount)
      : node.children;
  const rowClass = cn(
    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
    selectedPath === node.path && "bg-muted",
    onSelect && "cursor-pointer hover:bg-muted/70",
  );
  const body = (
    <>
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-label={live?.status ?? "idle"}
      />
      <span className="truncate font-medium">{node.label}</span>
      <span className="truncate font-mono text-[10px] text-muted-foreground">
        {node.kind}
        {node.layout !== "leaf" ? ` · ${node.layout}` : ""}
      </span>
      <NodeBadge node={node} live={live} />
      {live?.agentSessionId ? (
        <Link
          className="ml-auto truncate text-xs text-primary underline-offset-2 hover:underline"
          to={sessionHref(live.agentSessionId)}
          onClick={(event) => event.stopPropagation()}
        >
          session
        </Link>
      ) : null}
    </>
  );
  return (
    <li className="list-none">
      {node.kind === "agent" && live?.agentSessionId ? (
        <Link
          className={rowClass}
          to={sessionHref(live.agentSessionId)}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {body}
        </Link>
      ) : (
        <div
          className={rowClass}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => onSelect?.(node)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onSelect?.(node);
          }}
          role={onSelect ? "button" : undefined}
          tabIndex={onSelect ? 0 : undefined}
        >
          {body}
        </div>
      )}
      {children.length > 0 ? (
        <ul
          className={cn(
            "border-l border-border/60 ml-3",
            node.layout === "row" && "flex flex-col",
            node.layout === "lanes" && "grid gap-0",
            node.layout === "fork" && "grid gap-0",
          )}
        >
          {children.map((child) => (
            <TreeBranch
              key={child.path}
              node={child}
              liveByPath={liveByPath}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function WorkflowTree({
  root,
  liveByPath,
  selectedPath,
  onSelect,
}: Readonly<{
  root: WorkflowTreeNode;
  liveByPath: ReadonlyMap<string, NodeLiveState>;
  selectedPath?: string;
  onSelect?: (node: WorkflowTreeNode) => void;
}>) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <h2 className="text-sm font-medium">Workflow tree</h2>
        <span className="font-mono text-xs text-muted-foreground">{root.path}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <ul>
          <TreeBranch
            node={root}
            liveByPath={liveByPath}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        </ul>
      </div>
    </section>
  );
}
