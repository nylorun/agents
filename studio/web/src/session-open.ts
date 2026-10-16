/**
 * How Studio opens a session (protocol 16): by reading it. Only Studio's own "New session"
 * creates one, on the Agent its route names. What a session runs is the loop manifest it pinned
 * when it opened (`GET /v1/sessions/{id}/manifest`): its Agent's manifest version's harness
 * section, also for a flow's child session, which runs on the flow's Agent.
 */
import type { AgentManifestView, AgentView, SessionManifestView } from "@nylorun/agents";
import type { PinnedManifestState } from "./manifest/model.ts";
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

/** A session's page that resolves its Agent: what links to a child session use. */
export function sessionHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/** A definition from a loop manifest: a session's, or a flow's embedded agent's. */
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
  const tools = Array.isArray(manifest.tools)
    ? (manifest.tools as { name: string; description?: string }[])
    : undefined;
  return {
    id: String(manifest.id),
    name: String(manifest.name ?? manifest.id),
    ...hash,
    rawManifest: manifest,
    manifest: {
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
      ...(tools === undefined ? {} : { tools }),
    },
  };
}

/** A harness section (agent manifest v8) as the loop manifest a session on it pins, named `name`. */
export function harnessDefinition(
  name: string,
  harness: Readonly<Record<string, unknown>>,
  manifestHash?: string,
): StudioDefinition {
  return asStudioDefinition({
    manifest: { ...harness, id: name, name },
    ...(manifestHash === undefined ? {} : { manifestHash }),
  });
}

/** What `loadSessionDefinition` reads, of the SDK client. */
export type DefinitionReader = {
  hostFeatures(options?: { signal?: AbortSignal }): Promise<readonly string[]>;
  session(sessionId: string): {
    manifest(options?: { signal?: AbortSignal }): Promise<SessionManifestView>;
  };
  agents: {
    get(agentId: string, options?: { signal?: AbortSignal }): Promise<Pick<AgentView, "manifest" | "resolvedVersion">>;
  };
  agentManifests: {
    get(
      name: string,
      version?: number,
      options?: { signal?: AbortSignal },
    ): Promise<Pick<AgentManifestView, "name" | "version" | "hash" | "manifest">>;
  };
};

/** The name of the manifest an Agent reference names: `triage` of `triage` or `triage@3`. */
const nameOf = (reference: string) => {
  const at = reference.lastIndexOf("@");
  return at > 0 ? reference.slice(0, at) : reference;
};

/**
 * What session `sessionId` on Agent `agentId` runs, and how Studio knows it: the loop manifest
 * the session pinned (Host feature `session-reads`), else its Agent's manifest version's harness
 * section; with the manifest's latest version, which a newer version reaches through a fork of
 * the Agent. A session whose manifest cannot be read still opens, named by its Agent.
 */
export async function loadSessionDefinition(
  client: DefinitionReader,
  sessionId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<{ definition: StudioDefinition; pinned: PinnedManifestState }> {
  const options = signal ? { signal } : {};
  const latestOf = (name: string) =>
    client.agentManifests.get(name, undefined, options).then(
      (latest) => latest.version,
      () => undefined,
    );
  try {
    if ((await client.hostFeatures(options)).includes("session-reads")) {
      const read = await client.session(sessionId).manifest(options);
      const name = read.definition?.name ?? (typeof read.manifest.id === "string" ? read.manifest.id : agentId);
      const latest = read.definition ? await latestOf(read.definition.name) : undefined;
      return {
        definition: asStudioDefinition({
          manifest: { ...read.manifest, id: String(read.manifest.id ?? name), name: String(read.manifest.name ?? name) },
          manifestHash: read.manifestHash,
        }),
        pinned: {
          kind: "pinned",
          manifest: read.manifest,
          manifestHash: read.manifestHash,
          ...(read.definition ? { version: read.definition } : {}),
          ...(latest === undefined ? {} : { latest }),
        },
      };
    }
    const agent = await client.agents.get(agentId, options);
    const name = nameOf(agent.manifest);
    const [version, latest] = await Promise.all([
      client.agentManifests.get(name, agent.resolvedVersion, options),
      latestOf(name),
    ]);
    const harness = version.manifest.harness as unknown as Record<string, unknown>;
    return {
      definition: harnessDefinition(name, harness, version.hash),
      pinned: {
        kind: "agent",
        manifest: harness,
        version: { name, version: version.version },
        ...(latest === undefined ? {} : { latest }),
      },
    };
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return {
      definition: { id: agentId, name: agentId, manifest: {} },
      pinned: { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}
