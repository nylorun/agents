/**
 * How Studio opens a session: by reading it. Only Studio's own "New session"
 * creates one, and a session's agent need not be registered (a flow's
 * embedded agent runs in a child session).
 */
import type { StudioDefinition } from "./studio-types.ts";
import type { WorkflowManifest } from "./workflow/types.ts";

/**
 * Navigation state of Studio's own "New session": only then may opening a
 * session id that does not exist yet create it. Every other session (one from
 * the sidebar, a link or an application) is read as it is, whoever owns it.
 */
export const NEW_SESSION = { newSession: true } as const;

export function isNewSessionState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { newSession?: unknown }).newSession === true
  );
}

/** Who owns the sessions Studio starts (its proxy sets the same owner). */
export const STUDIO_OWNER = "local-developer";

/** The vaults a new session attaches, and the credential it picks where several match. */
export interface NewSessionCredentials {
  readonly vaultIds?: readonly string[];
  readonly credentialSelections?: readonly {
    readonly serverName: string;
    readonly credentialId: string;
  }[];
}

/** `NEW_SESSION` with the vaults the session attaches, when it attaches any. */
export function newSessionState(credentials: NewSessionCredentials = {}) {
  const vaultIds = credentials.vaultIds ?? [];
  const selections = credentials.credentialSelections ?? [];
  return {
    ...NEW_SESSION,
    ...(vaultIds.length ? { vaultIds: [...vaultIds] } : {}),
    ...(selections.length ? { credentialSelections: selections.map((item) => ({ ...item })) } : {}),
  };
}

/** The vaults a `newSessionState` carries, read back from navigation state. */
export function newSessionCredentials(state: unknown): NewSessionCredentials {
  if (!isNewSessionState(state)) return {};
  const { vaultIds, credentialSelections } = state as {
    vaultIds?: unknown;
    credentialSelections?: unknown;
  };
  const ids = Array.isArray(vaultIds)
    ? vaultIds.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  const selections = Array.isArray(credentialSelections)
    ? credentialSelections.flatMap((item: unknown) => {
        const { serverName, credentialId } = (item ?? {}) as Record<string, unknown>;
        return typeof serverName === "string" && typeof credentialId === "string"
          ? [{ serverName, credentialId }]
          : [];
      })
    : [];
  return {
    ...(ids.length ? { vaultIds: ids } : {}),
    ...(selections.length ? { credentialSelections: selections } : {}),
  };
}

/** A session's page that resolves its agent: what links to a child session use. */
export function sessionHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/** A definition from a manifest the Runtime lists or a workflow embeds. */
export function asStudioDefinition(raw: {
  manifest: Record<string, unknown> & { id: string; name?: string };
  manifestHash?: string;
}): StudioDefinition {
  const manifest = raw.manifest;
  const hash = raw.manifestHash === undefined ? {} : { manifestHash: raw.manifestHash };
  if (manifest.kind === "workflow") {
    return {
      id: String(manifest.id),
      name: String(manifest.name ?? manifest.id),
      kind: "workflow",
      ...hash,
      manifest: manifest as unknown as WorkflowManifest,
    };
  }
  const capabilities = Array.isArray(manifest.capabilities)
    ? (manifest.capabilities as {
        id: string;
        tools?: { name: string; description?: string }[];
        hooks?: { at: "before" | "after"; scope: "turn" | "step" }[];
      }[])
    : [];
  return {
    id: String(manifest.id),
    name: String(manifest.name ?? manifest.id),
    ...hash,
    rawManifest: manifest,
    manifest: {
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
      capabilities,
    },
  };
}

/** An embedded agent's manifest in a workflow (v2 `agents`, also in nested flows). */
function embeddedManifest(
  manifest: unknown,
  agentId: string,
): (Record<string, unknown> & { id: string }) | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const agents = (manifest as { agents?: unknown }).agents;
  if (typeof agents !== "object" || agents === null) return undefined;
  const entries = Object.entries(agents as Record<string, unknown>);
  const own = entries.find(([key]) => key === agentId)?.[1];
  if (typeof own === "object" && own !== null)
    return { ...(own as Record<string, unknown>), id: agentId };
  for (const [, nested] of entries) {
    const found = embeddedManifest(nested, agentId);
    if (found) return found;
  }
  return undefined;
}

/**
 * The definition a session runs: a registered agent, else the agent embedded
 * in a workflow (the session's own workflows first), else just its id.
 */
export function definitionForSession(
  agentId: string,
  agents: readonly StudioDefinition[],
  parentIds: readonly (string | undefined)[] = [],
): StudioDefinition {
  const registered = agents.find((a) => a.id === agentId);
  if (registered) return registered;
  const workflows = [
    ...agents.filter((a) => parentIds.includes(a.id)),
    ...agents.filter((a) => !parentIds.includes(a.id)),
  ].filter((a) => a.kind === "workflow");
  for (const workflow of workflows) {
    const manifest = embeddedManifest(workflow.manifest, agentId);
    if (manifest) return asStudioDefinition({ manifest });
  }
  return { id: agentId, name: agentId, manifest: { capabilities: [] } };
}
