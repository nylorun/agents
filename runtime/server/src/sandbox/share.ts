/**
 * A session's sandbox: the one of the Environment it names (protocol 11), whose id keys the
 * workspace, with the spec pinned when the session was opened (`Session.sandbox`). Definitions
 * no longer declare one (Sandboxes v3); `sandboxSpecOf` still reads a pinned manifest's.
 */
import {
  type AgentManifest,
  type SandboxManifest,
  type WorkflowManifest,
} from "@nylorun/core/define";

export type SessionSandboxRef = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly manifest: AgentManifest | WorkflowManifest | Record<string, unknown>;
  /** The Environment the session names; its id keys the workspace. */
  readonly environmentId?: string;
  /** The Environment's sandbox spec, pinned when the session was opened. */
  readonly sandbox?: SandboxManifest;
};

/** The session's sandbox spec: the one pinned at open, else the one its definition declares. */
export function sessionSandboxSpec(session: SessionSandboxRef): SandboxManifest | undefined {
  return session.sandbox ?? sandboxSpecOf(session.manifest);
}

/** The sandbox spec of a pinned agent manifest (its `runtime` block) or a workflow manifest. */
export function sandboxSpecOf(
  manifest: AgentManifest | WorkflowManifest | Record<string, unknown> | undefined
): SandboxManifest | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  if ((manifest as { kind?: unknown }).kind === "workflow")
    return (manifest as WorkflowManifest).sandbox;
  return (manifest as AgentManifest).runtime?.sandbox;
}

/**
 * Where a definition document declares a sandbox: a workflow's `sandbox`, and the agents embedded
 * in a flow agent. Definitions no longer declare one (Sandboxes v3), so registration refuses any
 * of these. An agent manifest cannot: its sandbox is in the `runtime` block, which the schema
 * refuses at registration.
 */
export function declaredSandboxes(manifest: unknown, into: string[] = []): string[] {
  if (!manifest || typeof manifest !== "object") return into;
  const document = manifest as {
    id?: string;
    kind?: string;
    sandbox?: unknown;
    agents?: Record<string, unknown>;
    tools?: { agent?: unknown }[];
  };
  if (document.kind === "workflow") {
    if (document.sandbox !== undefined) into.push(`flow agent '${document.id}'`);
    for (const agent of Object.values(document.agents ?? {})) declaredSandboxes(agent, into);
    return into;
  }
  for (const tool of document.tools ?? []) declaredSandboxes(tool.agent, into);
  return into;
}

/**
 * The agents of a definition document that set `runtime`: the document itself, the agents it
 * uses as tools and those embedded in a flow agent. Only the Runtime writes that block, when it
 * pins a session's manifest, so registration refuses any of these.
 */
export function authoredRuntimeBlocks(manifest: unknown, into: string[] = []): string[] {
  if (!manifest || typeof manifest !== "object") return into;
  const document = manifest as {
    id?: string;
    kind?: string;
    runtime?: unknown;
    agents?: Record<string, unknown>;
    tools?: { agent?: unknown }[];
  };
  if (document.kind === "workflow") {
    for (const agent of Object.values(document.agents ?? {})) authoredRuntimeBlocks(agent, into);
    return into;
  }
  if (document.runtime !== undefined) into.push(`'${document.id}'`);
  for (const tool of document.tools ?? []) authoredRuntimeBlocks(tool.agent, into);
  return into;
}

/**
 * The workspace a session's sandbox tools run in: the session, whose log records the
 * workspace's events, and its Environment, whose id keys the workspace.
 */
export function sandboxWorkspaceOf(
  session: SessionSandboxRef,
): { readonly ownerId: string; readonly environmentId?: string } {
  return session.environmentId === undefined
    ? { ownerId: session.id }
    : { ownerId: session.id, environmentId: session.environmentId };
}

export function sessionHasSandbox(session: SessionSandboxRef): boolean {
  return sessionSandboxSpec(session) !== undefined;
}
