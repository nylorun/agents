import type { LiveEvent } from "@nylorun/agents/client";

/** Studio row: Runtime LiveEvent plus delivery provenance. */
export type StudioEvent = LiveEvent &
  Readonly<{
    /** History `/items` load vs live SSE `/events` observation. */
    committed: boolean;
  }>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function compact(value: unknown): string {
  if (typeof value === "string")
    return value.length > 140 ? `${value.slice(0, 137)}…` : value;
  try {
    const result = JSON.stringify(value);
    if (result === undefined) return "—";
    return result.length > 140 ? `${result.slice(0, 137)}…` : result;
  } catch {
    return "Result is not serializable.";
  }
}

const LABELS: Readonly<Record<string, string>> = {
  "command.message": "Message",
  "command.cancel": "Cancel",
  "command.approve": "Approve",
  "command.respond": "Respond",
  "turn.completed": "Turn completed",
  "turn.waiting": "Turn waiting",
  "turn.uncertain": "Turn uncertain",
  "turn.failed": "Turn failed",
  "turn.cancelled": "Turn cancelled",
  "turn.runnable": "Turn runnable",
  "tool.completed": "Tool completed",
  "effect.uncertain": "Effect uncertain",
  "delegation.started": "Delegation started",
  "delegation.completed": "Delegation completed",
  "node.started": "Node started",
  "node.completed": "Node completed",
  "node.failed": "Node failed",
  "node.agent": "Node agent",
  "switch.selected": "Switch selected",
  "map.items": "Map items",
  "loop.iteration": "Loop iteration",
  "loop.waiting": "Loop waiting",
  "loop.verified": "Loop verified",
  "mcp.discovered": "MCP servers",
};

/** The agent used as a tool that an event belongs to; undefined for the session's root agent. */
export function agentOf(
  payload: unknown,
): Readonly<{ id: string; path: string; delegationId?: string }> | undefined {
  const agent = record(record(payload).agent);
  return typeof agent.id === "string" && typeof agent.path === "string"
    ? {
        id: agent.id,
        path: agent.path,
        ...(typeof agent.delegationId === "string"
          ? { delegationId: agent.delegationId }
          : {}),
      }
    : undefined;
}

/** Names the tool a `tool.completed` event is for: `Tool · name`, with its agent. */
export function toolLabel(payload: Readonly<Record<string, unknown>>): string {
  const agent = agentOf(payload);
  const owner = agent ? `${agent.id} › ` : "";
  return `${owner}Tool · ${text(payload.toolName, "tool")}`;
}

export function eventLabel(event: Pick<LiveEvent, "type">): string {
  return LABELS[event.type] ?? event.type.replaceAll(".", " ");
}

export function eventSummary(event: Pick<LiveEvent, "type" | "payload">): string {
  const payload = record(event.payload);
  switch (event.type) {
    case "command.message":
      return compact(payload.content);
    case "command.cancel":
      return text(payload.reason, "Cancel requested.");
    case "command.approve":
      return payload.approved === true ? "Approved." : "Denied.";
    case "command.respond":
      return compact(payload.value);
    case "turn.completed":
      return compact(payload.output);
    case "turn.failed":
      return text(payload.message, "The turn failed.");
    case "turn.cancelled":
      return text(payload.reason, "Turn cancelled.");
    case "turn.waiting":
    case "turn.uncertain":
    case "turn.runnable":
      return compact(payload.waits ?? payload);
    case "tool.completed":
      return `${toolLabel(payload)}: ${compact(payload.error ?? payload.output)}`;
    case "delegation.started":
      return `${agentOf(payload)?.id ?? "agent"}: ${compact(payload.task)}`;
    case "delegation.completed": {
      const outcome = record(payload.outcome);
      const status = text(payload.status, "settled");
      return `${agentOf(payload)?.id ?? "agent"} ${status}: ${compact(
        outcome.kind === "completed" ? outcome.output : (outcome.message ?? outcome),
      )}`;
    }
    case "effect.uncertain":
      return text(
        payload.message,
        text(payload.effectId, "Effect became uncertain."),
      );
    case "node.started":
      return `${text(payload.path, "node")} · ${text(payload.kind, "started")}`;
    case "node.completed":
      return `${text(payload.path, "node")} completed`;
    case "node.failed": {
      const error = record(payload.error);
      return `${text(payload.path, "node")}: ${text(error.message, text(error.code, "failed"))}`;
    }
    case "node.agent":
      return `${text(payload.path, "node")} → ${text(payload.sessionId, "session")}`;
    case "switch.selected":
      return `${text(payload.path, "switch")} → ${text(payload.case, "case")}`;
    case "map.items":
      return `${text(payload.path, "map")}: ${String(payload.count ?? 0)} items`;
    case "loop.iteration":
      return `${text(payload.path, "loop")} #${String(payload.n ?? "?")}`;
    case "loop.waiting":
      return `${text(payload.path, "loop")} #${String(payload.n ?? "?")} waiting`;
    case "loop.verified":
      return `${text(payload.path, "loop")} #${String(payload.n ?? "?")}: ${
        payload.pass === true ? "pass" : "fail"
      }${typeof payload.feedback === "string" ? ` — ${payload.feedback}` : ""}`;
    case "mcp.discovered": {
      const servers = Array.isArray(payload.servers) ? payload.servers.map(record) : [];
      if (servers.length === 0) return "No MCP servers.";
      return servers
        .map((server) => {
          const name = text(server.serverName, "server");
          if (server.outcome === "connected") {
            const tools = Number(server.tools ?? 0);
            return `${name}: ${tools} tool${tools === 1 ? "" : "s"}`;
          }
          return `${name} ${text(server.outcome, "failed")}: ${text(server.message, "no tools")}`;
        })
        .join(" · ");
    }
    default:
      return compact(event.payload);
  }
}

export function mergeStudioEvents(
  current: readonly StudioEvent[],
  incoming: readonly StudioEvent[],
): readonly StudioEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) {
    const prior = byId.get(event.eventId);
    byId.set(event.eventId, {
      ...event,
      committed: event.committed || prior?.committed === true,
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.time === b.time
      ? a.cursor.localeCompare(b.cursor)
      : a.time < b.time
        ? 1
        : -1,
  );
}
