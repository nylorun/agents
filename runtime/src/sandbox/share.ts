/**
 * Shared sandboxes: one sandbox per owning session, attached via PutSession.sandbox =
 * { session }; keys use the owner id. A sandbox is either declared by the definition (an agent
 * capability or a workflow's `sandbox`) or chosen when the session was opened and pinned on the
 * session record (`sandbox`).
 */
import {
  canonical,
  type AgentManifest,
  type CapabilityManifest,
  type SandboxManifest,
  type WorkflowManifest,
} from "@nylorun/core/define";

export type SessionSandboxRef = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly manifest: AgentManifest | WorkflowManifest | Record<string, unknown>;
  /** Session whose id keys the sandbox. Absent means this session owns its own. */
  readonly sandboxOwnerId?: string | null;
  /** The sandbox chosen when the session was opened (or inherited from its owner), resolved. */
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

export function sandboxSpecsEqual(
  a: SandboxManifest | undefined,
  b: SandboxManifest | undefined
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return canonical(a) === canonical(b);
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
 * Resolve the session id that keys the sandbox. Walks one hop via sandboxOwnerId;
 * cycles fall back to the starting session.
 */
export function owningSandboxSessionId(
  session: SessionSandboxRef,
  lookup: (id: string) => SessionSandboxRef | undefined
): string {
  const seen = new Set<string>();
  let current: SessionSandboxRef | undefined = session;
  while (current) {
    if (seen.has(current.id)) return session.id;
    seen.add(current.id);
    const ownerId = current.sandboxOwnerId;
    if (!ownerId || ownerId === current.id) return current.id;
    current = lookup(ownerId);
  }
  return session.id;
}

export function sessionHasSandbox(
  session: SessionSandboxRef,
  lookup: (id: string) => SessionSandboxRef | undefined
): boolean {
  const ownerId = owningSandboxSessionId(session, lookup);
  const owner = ownerId === session.id ? session : lookup(ownerId) ?? session;
  return sessionSandboxSpec(owner) !== undefined || sessionSandboxSpec(session) !== undefined;
}
