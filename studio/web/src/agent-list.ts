/**
 * The Agents list (protocol 16): one row per Agent, with the agent manifest version it runs,
 * its owner, its derived state, its sessions and its last activity, grouped by manifest in the
 * sidebar as sessions are by Agent. `/agents?state=<state>`, `?manifest=<name>`,
 * `?owner=<owner>` and `?label=key=value` (repeated) filter it; Agents whose sessions wait on a
 * person or fail come first. No React here, so `node --test` covers it.
 */
import type { AgentManifestView, AgentView } from "@nylorun/agents";

/** The query parameters of `/agents` that filter the list. */
export const STATE_FILTER = "state";
export const MANIFEST_FILTER = "manifest";
export const OWNER_FILTER = "owner";
export const LABEL_FILTER = "label";
/** The owner filter for Agents without an owner guard: never an owner, which is not empty. */
export const NO_OWNER = "-";

/** The states the list's filter offers, those that need a person first. */
export const AGENT_STATE_ORDER = ["input_required", "failing", "working", "sleeping", "paused"] as const;

/** What the list is filtered on: a state, a manifest, an owner (or `NO_OWNER`), and labels. */
export type AgentFilter = {
  state?: string;
  manifest?: string;
  owner?: string;
  labels: readonly string[];
};

/** `/agents`, filtered as given. */
export function agentsPath(filter: Partial<AgentFilter> = {}): string {
  const query = new URLSearchParams();
  if (filter.state !== undefined) query.set(STATE_FILTER, filter.state);
  if (filter.manifest !== undefined) query.set(MANIFEST_FILTER, filter.manifest);
  if (filter.owner !== undefined) query.set(OWNER_FILTER, filter.owner);
  for (const label of filter.labels ?? []) query.append(LABEL_FILTER, label);
  const text = query.toString();
  return text ? `/agents?${text}` : "/agents";
}

/** The filter `search` names; a label that is not `key=value` is ignored. */
export function agentFilter(search: string): AgentFilter {
  const query = new URLSearchParams(search);
  const state = query.get(STATE_FILTER) || undefined;
  const manifest = query.get(MANIFEST_FILTER) || undefined;
  const owner = query.get(OWNER_FILTER) || undefined;
  return {
    ...(state === undefined ? {} : { state }),
    ...(manifest === undefined ? {} : { manifest }),
    ...(owner === undefined ? {} : { owner }),
    labels: query.getAll(LABEL_FILTER).filter((label) => label.indexOf("=") > 0),
  };
}

/** The name of the manifest an Agent was made from: `triage` of `triage` or `triage@3`. */
export function manifestNameOf(agent: Pick<AgentView, "manifest">): string {
  const at = agent.manifest.lastIndexOf("@");
  return at > 0 ? agent.manifest.slice(0, at) : agent.manifest;
}

/** The version an Agent runs, as the list shows it: `triage@3`. */
export function manifestVersionOf(agent: Pick<AgentView, "manifest" | "resolvedVersion">): string {
  return `${manifestNameOf(agent)}@${agent.resolvedVersion}`;
}

/** `key=value` for each of an Agent's labels, in key order. */
export function labelsOf(agent: Pick<AgentView, "labels">): string[] {
  return Object.entries(agent.labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
}

/** The owner filter value an Agent matches. */
export function ownerOf(agent: Pick<AgentView, "owner">): string {
  return agent.owner ?? NO_OWNER;
}

/** The Agents the filter keeps, in the order given. */
export function filterAgents<T extends Pick<AgentView, "manifest" | "labels" | "state" | "owner">>(
  agents: readonly T[],
  filter: AgentFilter,
): T[] {
  return agents.filter((agent) => {
    if (filter.state !== undefined && agent.state !== filter.state) return false;
    if (filter.manifest !== undefined && manifestNameOf(agent) !== filter.manifest) return false;
    if (filter.owner !== undefined && ownerOf(agent) !== filter.owner) return false;
    return filter.labels.every((label) => {
      const at = label.indexOf("=");
      return agent.labels[label.slice(0, at)] === label.slice(at + 1);
    });
  });
}

/** What the list knows of a session to say when an Agent was last active. */
export type SessionActivity = {
  readonly agentId: string;
  readonly createdAt: string | null;
  readonly lastEventAt: string | null;
};

/**
 * When each Agent was last active: its latest session event (or session opening), or when it
 * was last used (a turn, a secret write, a stop or a reset), whichever is later.
 */
export function agentActivity(
  agents: readonly Pick<AgentView, "id" | "lastUsedAt">[],
  sessions: readonly SessionActivity[],
): Map<string, string> {
  const at = new Map<string, string>();
  const later = (id: string, value: string | null | undefined) => {
    if (!value || Number.isNaN(Date.parse(value))) return;
    const known = at.get(id);
    if (known === undefined || Date.parse(value) > Date.parse(known)) at.set(id, value);
  };
  for (const agent of agents) later(agent.id, agent.lastUsedAt);
  for (const session of sessions) later(session.agentId, session.lastEventAt ?? session.createdAt);
  return at;
}

/** Where a state sorts: input required, then failing, then every other state alike. */
const rank = (state: string) => (state === "input_required" ? 0 : state === "failing" ? 1 : 2);

/**
 * Agents as the list shows them: those that need input or fail first, then by last activity,
 * newest first; an Agent with no known activity goes last, and ties keep a stable order by id.
 */
export function sortAgents<T extends Pick<AgentView, "id" | "state">>(
  agents: readonly T[],
  activity: ReadonlyMap<string, string> = new Map(),
): T[] {
  const time = (agent: T) => {
    const value = activity.get(agent.id);
    return value === undefined ? undefined : Date.parse(value);
  };
  return [...agents].sort((a, b) => {
    const order = rank(a.state) - rank(b.state);
    if (order !== 0) return order;
    const x = time(a);
    const y = time(b);
    if (x !== y) {
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return y - x;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** A state as a person reads it: `Input required`. */
export function stateLabel(state: string): string {
  const text = state.replace(/_/gu, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A manifest the sidebar and the list group Agents by, with its Agents. */
export type AgentGroup = {
  /** The manifest's name. */
  name: string;
  /** Its latest saved version; absent for a manifest not listed (deleted, or not readable). */
  manifest?: AgentManifestView;
  agents: AgentView[];
};

/**
 * Each saved manifest by name, then any other manifest an Agent names, with their Agents in
 * the list's order.
 */
export function agentGroups(
  manifests: readonly AgentManifestView[],
  agents: readonly AgentView[],
  activity?: ReadonlyMap<string, string>,
): AgentGroup[] {
  const byName = new Map<string, AgentView[]>();
  for (const agent of agents) {
    const name = manifestNameOf(agent);
    byName.set(name, [...(byName.get(name) ?? []), agent]);
  }
  const groups: AgentGroup[] = [...manifests]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((manifest) => ({
      name: manifest.name,
      manifest,
      agents: sortAgents(byName.get(manifest.name) ?? [], activity),
    }));
  const listed = new Set(groups.map((group) => group.name));
  for (const [name, members] of [...byName].sort(([a], [b]) => a.localeCompare(b)))
    if (!listed.has(name)) groups.push({ name, agents: sortAgents(members, activity) });
  return groups;
}

/** True when an Agent runs a flow: its manifest's harness section is `kind: "workflow"`. */
export function isFlowManifest(manifest: Pick<AgentManifestView, "manifest"> | undefined): boolean {
  return (manifest?.manifest.harness as { kind?: unknown } | undefined)?.kind === "workflow";
}
