/**
 * A session's sandbox: the one of the Environment it names (protocol 11), whose id keys the
 * workspace, with the spec pinned when the session was opened (`Session.sandbox`, the one place
 * it is kept since protocol 15). Definitions declare none (Sandboxes v3).
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

/** The session's sandbox spec, pinned when it was opened (or inherited from its tree's owner). */
export function sessionSandboxSpec(session: Pick<SessionSandboxRef, "sandbox">): SandboxManifest | undefined {
  return session.sandbox;
}

/**
 * Where a definition document declares a sandbox: a workflow's `sandbox`, and the agents embedded
 * in a flow agent. Definitions no longer declare one (Sandboxes v3), so registration refuses any
 * of these. An agent manifest has no field for one.
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
