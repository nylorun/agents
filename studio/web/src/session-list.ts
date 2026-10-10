import type { Connection, StudioDefinition } from "@/studio-types";

/** The query parameter of `/sessions` that filters the list to one agent. */
export const AGENT_FILTER = "agent";

export function sessionsPath(agentId?: string): string {
  return agentId === undefined
    ? "/sessions"
    : `/sessions?${AGENT_FILTER}=${encodeURIComponent(agentId)}`;
}

export function sessionPath(agentId: string, sessionId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function isWorkflowDefinition(agent: StudioDefinition): boolean {
  return agent.kind === "workflow" || agent.manifest.kind === "workflow";
}

/** An agent the session list can filter on, with its number of sessions. */
export type SessionAgent = {
  id: string;
  name: string;
  workflow: boolean;
  /** False for an agent only sessions name, such as a flow's embedded agent. */
  registered: boolean;
  count: number;
};

/** The registered agents, then any other agent a session runs, with their session counts. */
export function sessionAgents(connection: Pick<Connection, "agents" | "sessions">): SessionAgent[] {
  const counts = new Map<string, number>();
  for (const session of connection.sessions)
    counts.set(session.agentId, (counts.get(session.agentId) ?? 0) + 1);
  const agents: SessionAgent[] = connection.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    workflow: isWorkflowDefinition(agent),
    registered: true,
    count: counts.get(agent.id) ?? 0,
  }));
  const registered = new Set(agents.map((agent) => agent.id));
  for (const [id, count] of counts)
    if (!registered.has(id))
      agents.push({ id, name: id, workflow: false, registered: false, count });
  return agents;
}
