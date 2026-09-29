/**
 * HTTP handlers for session-scoped and claim-scoped sandbox tool endpoints.
 * Wired from TenantRuntime; keeps route bodies out of the hot runtime file.
 */
import {
  isSandboxToolName,
  type SandboxManifest,
  type SandboxToolName,
} from "@nylorun/core/define";
import type { Action } from "@nylorun/core/contracts";
import type { SandboxManager, SandboxSessionRef } from "../sandbox/manager.js";
import type { SandboxToolOutcome } from "../sandbox/tools.js";
import {
  capabilityForSandbox,
  owningSandboxSessionId,
  sandboxSpecOf,
  sandboxSpecsEqual,
  sessionSandboxSpec,
  type SessionSandboxRef,
} from "../sandbox/share.js";

export class SandboxRouteError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "SandboxRouteError";
  }
}

export type SandboxRouteSession = SessionSandboxRef & {
  readonly activeTurnId: string | null;
  readonly status: string;
};

/** A session together with a synchronous lookup over its sandbox owner chain. */
export type SandboxRouteRead = {
  readonly session: SandboxRouteSession;
  readonly lookup: (id: string) => SessionSandboxRef | undefined;
};

export type SandboxRouteDeps = {
  readonly sandbox: SandboxManager;
  /** The session (rejects when missing) and its owner chain, read in one transaction. */
  readonly session: (id: string) => Promise<SandboxRouteRead>;
  readonly getAction: (id: string) => Promise<Action | undefined>;
};

function resolveSpec(session: SessionSandboxRef, lookup: SandboxRouteRead["lookup"]): SandboxManifest {
  const ownerId = owningSandboxSessionId(session, lookup);
  const owner = ownerId === session.id ? session : lookup(ownerId) ?? session;
  const spec = sessionSandboxSpec(owner) ?? sessionSandboxSpec(session);
  if (!spec)
    throw new SandboxRouteError(404, "Session has no sandbox");
  return spec;
}

function parseTool(tool: string): SandboxToolName {
  if (!isSandboxToolName(tool))
    throw new SandboxRouteError(400, `Unknown sandbox tool '${tool}'`);
  return tool;
}

function toolInput(body: unknown): unknown {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body))
    throw new SandboxRouteError(400, "Sandbox tool body must be an object");
  const record = body as Record<string, unknown>;
  const { claimId: _c, generation: _g, requestId: _r, ...input } = record;
  return input;
}

async function runTool(
  deps: SandboxRouteDeps,
  { session, lookup }: SandboxRouteRead,
  tool: SandboxToolName,
  input: unknown,
  signal: AbortSignal
): Promise<SandboxToolOutcome> {
  const spec = resolveSpec(session, lookup);
  const ownerId = owningSandboxSessionId(session, lookup);
  const ref: SandboxSessionRef = {
    id: ownerId,
    activeTurnId: session.activeTurnId,
    manifest: session.manifest as SandboxSessionRef["manifest"],
  };
  return deps.sandbox.run(ref, capabilityForSandbox(spec), tool, input, signal);
}

/**
 * `POST /v1/sessions/:id/sandbox/:tool` — application principal.
 * Refused while the session has an active agent turn.
 */
export async function handleSessionSandboxTool(
  deps: SandboxRouteDeps,
  sessionId: string,
  toolName: string,
  body: unknown,
  signal: AbortSignal
): Promise<SandboxToolOutcome> {
  const read = await deps.session(sessionId);
  if (read.session.activeTurnId)
    throw new SandboxRouteError(
      409,
      "Sandbox is unavailable while the session has an active agent turn"
    );
  const tool = parseTool(toolName);
  return runTool(deps, read, tool, toolInput(body), signal);
}

/**
 * `POST /v1/actions/:id/sandbox/:tool` — executor, authorized by the live claim.
 * Body must include claimId and generation matching the claimed action.
 */
export async function handleActionSandboxTool(
  deps: SandboxRouteDeps,
  actionId: string,
  toolName: string,
  body: unknown,
  signal: AbortSignal
): Promise<SandboxToolOutcome> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new SandboxRouteError(400, "Sandbox tool body must be an object");
  const record = body as Record<string, unknown>;
  const claimId = record.claimId;
  const generation = record.generation;
  if (typeof claimId !== "string" || claimId.length === 0)
    throw new SandboxRouteError(400, "claimId is required");
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1)
    throw new SandboxRouteError(400, "generation must be a positive integer");

  const action = await deps.getAction(actionId);
  if (!action) throw new SandboxRouteError(404, "Action not found");
  if (
    action.status !== "claimed" ||
    action.claimId !== claimId ||
    action.generation !== generation ||
    !action.leaseExpiresAt ||
    Date.parse(action.leaseExpiresAt) <= Date.now()
  )
    throw new SandboxRouteError(409, "Stale or expired claim");

  const read = await deps.session(action.sessionId);
  if (read.session.activeTurnId !== action.turnId)
    throw new SandboxRouteError(409, "Action unavailable");

  const tool = parseTool(toolName);
  return runTool(deps, read, tool, toolInput(body), signal);
}

/**
 * Validate PutSession.sandbox attach: same owner, and a sandbox to share. A session whose
 * definition declares a sandbox must declare the owner's spec; one whose definition declares
 * none inherits it (`inherit`).
 */
export function validateSandboxAttach(
  body: { ownerUserId: string; sandbox?: unknown },
  newManifest: SessionSandboxRef["manifest"],
  lookup: (id: string) => SessionSandboxRef | undefined,
  /** Acting for a subject: another owner's session is the 404 of a missing one. */
  options: { opaque?: boolean; inherit?: boolean } = {}
): string | undefined {
  const request = body.sandbox;
  const share =
    typeof request === "object" && request !== null && "session" in request
      ? String((request as { session: unknown }).session)
      : undefined;
  if (!share) return undefined;
  const owner = lookup(share);
  if (!owner || (options.opaque && owner.ownerUserId !== body.ownerUserId))
    throw new SandboxRouteError(404, "Sandbox session not found");
  if (owner.ownerUserId !== body.ownerUserId)
    throw new SandboxRouteError(
      403,
      "Sandbox session must belong to the same owner"
    );
  const ownerSpec = sessionSandboxSpec(owner);
  if (!ownerSpec)
    throw new SandboxRouteError(400, "Target session has no sandbox to share");
  if (options.inherit) return owningSandboxSessionId(owner, lookup);
  const newSpec = sandboxSpecOf(newManifest);
  if (!newSpec)
    throw new SandboxRouteError(
      400,
      "Session must declare a sandbox identical to the shared session"
    );
  if (!sandboxSpecsEqual(ownerSpec, newSpec))
    throw new SandboxRouteError(
      409,
      "Sandbox specs must be identical to share a sandbox"
    );
  return owningSandboxSessionId(owner, lookup);
}
