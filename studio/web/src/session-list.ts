import type { AgentManifestView, AgentView } from "@nylorun/agents";
import type { SessionSummary } from "@/studio-types";
import { isFlowManifest, manifestNameOf } from "./agent-list.ts";

/** The query parameter of `/sessions` that filters the list to one Agent. */
export const AGENT_FILTER = "agent";

export function sessionsPath(agentId?: string): string {
  return agentId === undefined
    ? "/sessions"
    : `/sessions?${AGENT_FILTER}=${encodeURIComponent(agentId)}`;
}

/** A session's page, under the Agent it runs on. */
export function sessionPath(agentId: string, sessionId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`;
}

/** An Agent the session list can filter on, with its number of sessions. */
export type SessionAgent = {
  id: string;
  /** The Agent's id: an Agent has no other name. */
  name: string;
  /** Its manifest's harness section is a flow. */
  workflow: boolean;
  /** False for an Agent only sessions name, such as one deleted or not readable. */
  listed: boolean;
  count: number;
};

/** The Tenant's Agents, then any other Agent a session runs on, with their session counts. */
export function sessionAgents(
  agents: readonly Pick<AgentView, "id" | "manifest">[],
  sessions: readonly Pick<SessionSummary, "agentId">[],
  manifests: readonly AgentManifestView[] = [],
): SessionAgent[] {
  const counts = new Map<string, number>();
  for (const session of sessions)
    counts.set(session.agentId, (counts.get(session.agentId) ?? 0) + 1);
  const flows = new Set(manifests.filter((manifest) => isFlowManifest(manifest)).map((manifest) => manifest.name));
  const listed: SessionAgent[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.id,
    workflow: flows.has(manifestNameOf(agent)),
    listed: true,
    count: counts.get(agent.id) ?? 0,
  }));
  const known = new Set(listed.map((agent) => agent.id));
  for (const [id, count] of counts)
    if (!known.has(id)) listed.push({ id, name: id, workflow: false, listed: false, count });
  return listed;
}

/** The page size Studio reads the session list in (the Runtime's most). */
const SESSION_PAGE = 200;

/** What `loadSessions` needs of the SDK client. */
export type SessionLister = {
  hostFeatures(): Promise<readonly string[]>;
  sessions: {
    page(options: { limit: number; cursor?: string }): Promise<{
      sessions: readonly (Omit<SessionSummary, "session"> & { id: string })[];
      nextCursor: string | null;
    }>;
  };
  listSessions(): Promise<{
    sessions: readonly { id: string; agentId: string; ownerUserId: string; status: string }[];
  }>;
};

/**
 * Every session of the Tenant. With `session-reads` the Runtime's pages carry when each session
 * opened and when its last event was committed; without it the plain list has no times.
 */
export async function loadSessions(client: SessionLister): Promise<SessionSummary[]> {
  if ((await client.hostFeatures()).includes("session-reads")) {
    const sessions: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.sessions.page({
        limit: SESSION_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const s of page.sessions)
        sessions.push({
          session: s.id,
          agentId: s.agentId,
          ownerUserId: s.ownerUserId,
          status: s.status,
          createdAt: s.createdAt,
          lastEventAt: s.lastEventAt,
        });
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return sessions;
  }
  const listed = await client.listSessions();
  return listed.sessions.map((s) => ({
    session: s.id,
    agentId: s.agentId,
    ownerUserId: s.ownerUserId,
    status: s.status,
    createdAt: null,
    lastEventAt: null,
  }));
}

/** A session's last activity: its last event, else when it opened; null when neither is known. */
export function lastActivity(
  session: Pick<SessionSummary, "createdAt" | "lastEventAt">,
): string | null {
  return session.lastEventAt ?? session.createdAt;
}

export type SessionOrder = "newest" | "oldest";

/**
 * Sessions by last activity, newest or oldest first. A session with no known time goes last in
 * either order; ties keep a stable order by id.
 */
export function sortSessions<T extends Pick<SessionSummary, "session" | "createdAt" | "lastEventAt">>(
  sessions: readonly T[],
  order: SessionOrder,
): T[] {
  const time = (session: T): number | undefined => {
    const at = lastActivity(session);
    const ms = at === null ? Number.NaN : Date.parse(at);
    return Number.isNaN(ms) ? undefined : ms;
  };
  return [...sessions].sort((a, b) => {
    const x = time(a);
    const y = time(b);
    if (x !== y) {
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return order === "newest" ? y - x : x - y;
    }
    return a.session < b.session ? -1 : a.session > b.session ? 1 : 0;
  });
}
