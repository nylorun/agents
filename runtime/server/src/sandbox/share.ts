/**
 * A session's sandbox: the one of the Environment it names (protocol 11), whose id keys the
 * workspace, with the spec pinned when the session was opened (`Session.sandbox`). Definitions
 * no longer declare one (Sandboxes v3); `sandboxSpecOf` still reads a pinned manifest's.
 */
import {
  type AgentManifest,
  type CapabilityManifest,
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

/** Sandbox spec declared on an agent capability or a workflow manifest. */
export function sandboxSpecOf(
  manifest: AgentManifest | WorkflowManifest | Record<string, unknown> | undefined
): SandboxManifest | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  if ((manifest as { kind?: unknown }).kind === "workflow")
    return (manifest as WorkflowManifest).sandbox;
  const capabilities = (manifest as AgentManifest).capabilities;
  if (!Array.isArray(capabilities)) return undefined;
  for (const capability of capabilities)
    if (capability.sandbox) return capability.sandbox;
  return undefined;
}

/**
 * Where a definition document declares a sandbox: agent capabilities, the agents inlined as
 * tools or embedded in a flow agent, and a workflow's `sandbox`. Definitions no longer declare
 * one (Sandboxes v3), so registration refuses any of these.
 */
export function declaredSandboxes(manifest: unknown, into: string[] = []): string[] {
  if (!manifest || typeof manifest !== "object") return into;
  const document = manifest as {
    id?: string;
    kind?: string;
    sandbox?: unknown;
    agents?: Record<string, unknown>;
    capabilities?: { id: string; sandbox?: unknown; tools?: { agent?: unknown }[] }[];
  };
  if (document.kind === "workflow") {
    if (document.sandbox !== undefined) into.push(`flow agent '${document.id}'`);
    for (const agent of Object.values(document.agents ?? {})) declaredSandboxes(agent, into);
    return into;
  }
  for (const capability of document.capabilities ?? []) {
    if (capability.sandbox !== undefined)
      into.push(`'${document.id}' (capability '${capability.id}')`);
    for (const tool of capability.tools ?? []) declaredSandboxes(tool.agent, into);
  }
  return into;
}

/** Synthetic capability so SandboxManager.run can use a workflow (or shared) spec. */
export function capabilityForSandbox(sandbox: SandboxManifest): CapabilityManifest {
  return {
    id: "sandbox",
    type: "agent",
    sandbox,
    tools: [],
  };
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
