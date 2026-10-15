/**
 * HTTP handlers for the session-scoped sandbox tool route (`POST /v1/sessions/:id/sandbox/:tool`):
 * a tool run in the sandbox of the session's Environment.
 */
import {
  isSandboxToolName,
  type SandboxManifest,
  type SandboxToolName,
} from "@nylorun/core/define";
import type { SandboxSessionRef } from "../sandbox/manager.js";
import type { WorkspacePort } from "../harness-api/workspace.js";
import type { SandboxToolOutcome } from "../sandbox/tools.js";
import {
  sandboxWorkspaceOf,
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

export type SandboxRouteDeps = {
  readonly sandbox: Pick<WorkspacePort, "run">;
  /** The session; rejects when it is missing. */
  readonly session: (id: string) => Promise<SandboxRouteSession>;
};

function resolveSpec(session: SessionSandboxRef): SandboxManifest {
  const spec = sessionSandboxSpec(session);
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
  const { requestId: _r, ...input } = record;
  return input;
}

async function runTool(
  deps: SandboxRouteDeps,
  session: SandboxRouteSession,
  tool: SandboxToolName,
  input: unknown,
  signal: AbortSignal
): Promise<SandboxToolOutcome> {
  const spec = resolveSpec(session);
  const workspace = sandboxWorkspaceOf(session);
  const ref: SandboxSessionRef = {
    id: workspace.ownerId,
    activeTurnId: session.activeTurnId,
    ...(workspace.environmentId === undefined ? {} : { environmentId: workspace.environmentId }),
  };
  return deps.sandbox.run(ref, spec, tool, input, signal);
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
  if (read.activeTurnId)
    throw new SandboxRouteError(
      409,
      "Sandbox is unavailable while the session has an active agent turn"
    );
  const tool = parseTool(toolName);
  return runTool(deps, read, tool, toolInput(body), signal);
}
