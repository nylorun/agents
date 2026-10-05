import {
  nodeKeyOf,
  payloadOf,
  type EventLike,
  type NodeLiveState,
  type NodeRunStatus,
} from "./types.ts";

const idle: NodeLiveState = { status: "idle" };

function set(
  map: Map<string, NodeLiveState>,
  path: string,
  patch: Partial<NodeLiveState> & { readonly status?: NodeRunStatus },
): void {
  const prior = map.get(path) ?? idle;
  map.set(path, { ...prior, ...patch });
  // A Map item's path (`writer[1]`) also lights the node the tree draws (`writer`).
  const template = nodeKeyOf(path);
  if (template !== path) map.set(template, { ...(map.get(template) ?? idle), ...patch });
}

/**
 * Colour / status for each manifest path from seam LiveEvents
 * (`node.*`, `switch.*`, `map.*`, `loop.*`, `action.*` with path).
 */
export function liveStatusFromEvents(
  events: readonly EventLike[],
): ReadonlyMap<string, NodeLiveState> {
  const byPath = new Map<string, NodeLiveState>();
  // Chronological: fixtures and history may arrive newest-first; sort by nothing —
  // callers pass oldest-first. When order is unknown, last write wins.
  for (const event of events) {
    const payload = payloadOf(event);
    const path = typeof payload.path === "string" ? payload.path : undefined;
    if (!path) continue;
    const iterations =
      typeof payload.iterations === "string" ? payload.iterations : undefined;
    switch (event.type) {
      case "node.started":
        set(byPath, path, {
          status: "running",
          ...(iterations ? { iterations } : {}),
        });
        break;
      case "node.completed":
        set(byPath, path, {
          status: "completed",
          ...(iterations ? { iterations } : {}),
        });
        break;
      case "node.failed": {
        const error = payload.error as
          | { code?: string; message?: string }
          | undefined;
        set(byPath, path, {
          status: "failed",
          ...(iterations ? { iterations } : {}),
          error: {
            code: String(error?.code ?? "failed"),
            message: String(error?.message ?? "Node failed"),
          },
        });
        break;
      }
      case "node.agent":
        set(byPath, path, {
          status: byPath.get(path)?.status === "completed" ? "completed" : "running",
          ...(iterations ? { iterations } : {}),
          ...(typeof payload.sessionId === "string"
            ? { agentSessionId: payload.sessionId }
            : {}),
          ...(typeof payload.turnId === "string"
            ? { agentTurnId: payload.turnId }
            : {}),
        });
        break;
      case "switch.selected":
        set(byPath, path, {
          status: "selected",
          selectedCase: String(payload.case ?? ""),
        });
        if (typeof payload.case === "string")
          set(byPath, `${path}/${payload.case}`, { status: "selected" });
        break;
      case "map.items":
        set(byPath, path, {
          status: byPath.get(path)?.status ?? "running",
          mapCount: Number(payload.count ?? 0),
        });
        break;
      case "loop.iteration":
        set(byPath, path, {
          status: "running",
          iteration: Number(payload.n ?? 0),
          ...(typeof payload.sessionId === "string"
            ? { agentSessionId: payload.sessionId }
            : {}),
          ...(typeof payload.turnId === "string"
            ? { agentTurnId: payload.turnId }
            : {}),
        });
        break;
      case "loop.waiting":
        set(byPath, path, {
          status: "waiting",
          iteration: Number(payload.n ?? 0),
          ...(typeof payload.sessionId === "string"
            ? { agentSessionId: payload.sessionId }
            : {}),
        });
        break;
      // A fail verdict retries the body; the Loop fails only when it runs out of attempts.
      case "loop.verified":
        set(byPath, path, {
          status: payload.pass === true ? "completed" : "running",
          iteration: Number(payload.n ?? 0),
        });
        break;
      case "action.pending":
      case "action.delivered":
      case "action.delivery_failed":
        set(byPath, path, { status: "running", ...(iterations ? { iterations } : {}) });
        break;
      case "action.completed":
        set(byPath, path, {
          status: "completed",
          ...(iterations ? { iterations } : {}),
        });
        break;
      case "action.uncertain":
        set(byPath, path, {
          status: "waiting",
          ...(iterations ? { iterations } : {}),
        });
        break;
      default:
        break;
    }
  }
  return byPath;
}

export function statusColor(status: NodeRunStatus): string {
  switch (status) {
    case "running":
      return "var(--workflow-running, #2563eb)";
    case "completed":
      return "var(--workflow-completed, #059669)";
    case "failed":
      return "var(--workflow-failed, #dc2626)";
    case "waiting":
      return "var(--workflow-waiting, #d97706)";
    case "selected":
      return "var(--workflow-selected, #7c3aed)";
    default:
      return "var(--workflow-idle, #94a3b8)";
  }
}
