import { payloadOf, type EventLike, type WorkflowLink } from "./types.ts";

/**
 * Build agent↔workflow links from `node.agent` events and optional Runtime
 * links-index records (fixtures when the public API is absent).
 * Path is the agent node path.
 */
export function linksFromEvents(
  events: readonly EventLike[],
  workflowSessionId: string,
  options: { readonly workflowAgentId?: string } = {},
): ReadonlyMap<string, WorkflowLink> {
  const links = new Map<string, WorkflowLink>();
  for (const event of events) {
    if (event.type !== "node.agent") continue;
    const payload = payloadOf(event);
    const sessionId =
      typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    const path = typeof payload.path === "string" ? payload.path : undefined;
    if (!sessionId || !path) continue;
    links.set(sessionId, {
      workflowSessionId,
      path,
      ...(options.workflowAgentId
        ? { workflowAgentId: options.workflowAgentId }
        : {}),
    });
  }
  return links;
}

/** Merge Runtime links-index rows into the map (agentSessionId is the key). */
export function mergeLinkIndex(
  current: ReadonlyMap<string, WorkflowLink>,
  rows: readonly {
    readonly agentSessionId: string;
    readonly workflowSessionId: string;
    readonly path: string;
    readonly workflowAgentId?: string;
  }[],
): ReadonlyMap<string, WorkflowLink> {
  const next = new Map(current);
  for (const row of rows) {
    next.set(row.agentSessionId, {
      workflowSessionId: row.workflowSessionId,
      path: row.path,
      ...(row.workflowAgentId ? { workflowAgentId: row.workflowAgentId } : {}),
    });
  }
  return next;
}

export function workflowLinkFor(
  agentSessionId: string,
  links: ReadonlyMap<string, WorkflowLink>,
): WorkflowLink | undefined {
  return links.get(agentSessionId);
}
