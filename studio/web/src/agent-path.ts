/**
 * Where an Agent lives in Studio (protocol 16): `/agents/<id>` (the id percent-encoded as one
 * segment, since it may hold `/`) with `?tab=`, its sessions under
 * `/agents/<id>/sessions/<sessionId>`, the agent manifests under `/agent-manifests`, and where
 * the routes Studio used before point now. An Agent holds its compute, its vault's secrets, its
 * disk versions and its sessions, so its page replaced the Environment's, which had replaced
 * `/environments?selected=`, the Credentials settings page and `/vault`. No React here, so
 * `node --test` covers it.
 */

/**
 * The tabs of an Agent's page, in order: what it does (its sessions and the triggers that start
 * them), what it keeps (artifacts, memory, disk), what happened (activity), and how it is set
 * up (its vault, and the manifest version it is an instance of). It opens on its sessions.
 */
export const AGENT_TABS = [
  "sessions",
  "triggers",
  "artifacts",
  "memory",
  "disk",
  "activity",
  "vault",
  "manifest",
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export function isAgentTab(value: unknown): value is AgentTab {
  return AGENT_TABS.includes(value as AgentTab);
}

/** Where each tab the page had before lives now: its overview opened the page. */
const RENAMED_TABS: Readonly<Record<string, AgentTab>> = {
  overview: "sessions",
  details: "sessions",
  secrets: "vault",
  setup: "manifest",
  events: "activity",
};

/** The tab `?tab=` names, an old name read as its new one; undefined for none or an unknown one. */
export function agentTabOf(value: string | null): AgentTab | undefined {
  if (value === null) return undefined;
  return isAgentTab(value) ? value : RENAMED_TABS[value];
}

/** `/agents/<id>`, opened on `tab` (its sessions when omitted). */
export function agentPath(id: string, tab?: AgentTab): string {
  const path = `/agents/${encodeURIComponent(id)}`;
  return tab === undefined || tab === "sessions" ? path : `${path}?tab=${tab}`;
}

/**
 * `/agent-manifests`, or the list with one manifest open beside it, on `version` (its latest
 * when omitted).
 */
export function manifestPath(name?: string, version?: number): string {
  if (name === undefined) return "/agent-manifests";
  const query = new URLSearchParams({ selected: name });
  if (version !== undefined) query.set("version", String(version));
  return `/agent-manifests?${query}`;
}

type Route<Kind extends string> =
  | { kind: "list" }
  | ({ kind: Kind } & { id: string })
  | { kind: "invalid"; segment: string }
  | undefined;

function routeOf<Kind extends string>(prefix: string, kind: Kind, pathname: string): Route<Kind> {
  if (new RegExp(`^/${prefix}/?$`, "u").test(pathname)) return { kind: "list" };
  const segment = pathname.match(new RegExp(`^/${prefix}/([^/]+)/?$`, "u"))?.[1];
  if (segment === undefined) return undefined;
  try {
    return { kind, id: decodeURIComponent(segment) };
  } catch {
    return { kind: "invalid", segment };
  }
}

/**
 * What `pathname` names: the Agents list, one Agent (its decoded id), or a segment that is no
 * valid percent-encoding (`invalid`, shown as "not found"). Undefined off `/agents` and on a
 * session's page (`/agents/<id>/sessions/<sessionId>`).
 */
export function agentRoute(pathname: string): Route<"agent"> {
  return routeOf("agents", "agent", pathname);
}

/** What `pathname` names under `/agent-manifests`: the list, one manifest, or an invalid segment. */
export function manifestRoute(pathname: string): Route<"manifest"> {
  return routeOf("agent-manifests", "manifest", pathname);
}

/** The tab an old `?tab=` names on an Agent's page. */
function legacyTab(value: string | null): AgentTab | undefined {
  return agentTabOf(value);
}

/**
 * Where an old Studio route goes now, keeping the rest of its query; undefined when `pathname`
 * is no old route:
 * - `/environments/<id>` → `/agents/<id>`, and `/environments?selected=<id>&tab=` → its tab
 * - `/environments` → `/agents` (its `manifest` and `label` filters kept)
 * - `/settings/credentials?environment=<id>` and `/vault?environment=<id>` → its Vault tab
 * - those without an Environment, and `/sandboxes` → `/agents`
 * - `/agent-manifests/<name>?version=` → the manifests list with that manifest open beside it
 * - `/` and `/sessions` → `/agents`, Studio's home; `/sessions?agent=<id>` → that Agent's page,
 *   which opens on its sessions (a session always runs on one Agent, so its sessions live there)
 */
export function legacyRedirect(pathname: string, search: string): string | undefined {
  const query = new URLSearchParams(search);
  const rest = (drop: readonly string[]) => {
    for (const key of drop) query.delete(key);
    return query;
  };
  const withQuery = (path: string, extra: URLSearchParams) => {
    const [base, own] = path.split("?");
    const merged = new URLSearchParams(own);
    for (const [key, value] of extra) if (!merged.has(key)) merged.append(key, value);
    const text = merged.toString();
    return text ? `${base}?${text}` : base!;
  };
  if (/^\/environments\/?$/u.test(pathname)) {
    const selected = query.get("selected");
    if (!selected) return withQuery("/agents", query);
    const tab = legacyTab(query.get("tab"));
    return withQuery(agentPath(selected, tab), rest(["selected", "tab"]));
  }
  const segment = pathname.match(/^\/environments\/([^/]+)\/?$/u)?.[1];
  // The segment stays as it was encoded: an Agent's id is the Environment's.
  if (segment !== undefined) return withQuery(`/agents/${segment}`, query);
  if (/^\/(?:settings\/credentials|vault)\/?$/u.test(pathname)) {
    const environment = query.get("environment");
    return environment
      ? withQuery(agentPath(environment, "vault"), rest(["environment"]))
      : withQuery("/agents", rest(["environment"]));
  }
  if (/^\/sandboxes\/?$/u.test(pathname)) return withQuery("/agents", query);
  const manifest = pathname.match(/^\/agent-manifests\/([^/]+)\/?$/u)?.[1];
  if (manifest !== undefined) {
    let name: string;
    try {
      name = decodeURIComponent(manifest);
    } catch {
      // Not a valid encoding: the page says the manifest is not found.
      return undefined;
    }
    return withQuery(manifestPath(name), query);
  }
  if (pathname === "/" || /^\/sessions\/?$/u.test(pathname)) {
    const agent = query.get("agent");
    return agent ? withQuery(agentPath(agent), rest(["agent"])) : withQuery("/agents", query);
  }
  return undefined;
}
