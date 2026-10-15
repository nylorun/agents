/**
 * The calls a harness executes, as pure helpers over what routes them: the Model Gate (or the
 * Tenant's provider), the Tool Gate, the MCP pool, the SandboxManager. No store, no record: the
 * session's routing comes with the run (`TurnStart.routing`).
 */
import { isSandboxToolName, type AgentManifest, type SandboxManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import type { SandboxToolLimits } from "@nylorun/harness";
import { runAbortKind } from "@nylorun/harness/api";
import type { AbortReason } from "@nylorun/core/harness-api";
import type { RuntimeModelCall } from "../contracts.js";
import type { ModelProvider } from "../core/provider.js";
import type { ModelGate } from "../gates/model-gate.js";
import type { ToolGate } from "../gates/tool-gate.js";
import { httpToolRefOf } from "../gates/http-tool.js";
import { classifyThrown } from "../model/classify.js";
import { findServer, type McpPool } from "../mcp/pool.js";
import type { SandboxManager } from "../sandbox/manager.js";

/** Where a Tenant's model calls go. */
export interface ModelRoute {
  readonly tenantId: string;
  readonly modelGate: ModelGate;
  readonly modelProvider: ModelProvider;
  /** True when the model comes from the Tenant vault selection, served by `modelGate`. */
  readonly useVaultModel: boolean;
}

/** What a session's tool calls are routed by. */
export interface ToolRouting {
  readonly rootManifest: AgentManifest;
  /** The session that owns the tree's sandbox, and the sandbox resource it is attached to. */
  readonly sandboxOwnerId: string;
  /** The sandbox spec the session pinned (`routing.sandbox.spec`); absent without a sandbox. */
  readonly spec?: SandboxManifest;
  readonly environmentId?: string;
  /** Variables every sandbox command gets (R2c): secret names set to the sentinel, plain values. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly activeTurnId: string | null;
  /** Who the sandbox call's events are claimed for: the run's id. */
  readonly claim?: string;
}

/**
 * Call the model for one effect. A provider failure comes back as a failure outcome
 * (Model Calls §6), whichever provider serves the call; only an abort throws, and the
 * advance decides what the abort means. `atGate` sends the call to the Model Gate even when the
 * Tenant's model is not from the vault: the Tenant's fixture model is answered there (R4.3).
 */
export async function invokeModel(
  route: ModelRoute,
  request: HostEffect,
  signal: AbortSignal,
  options: { readonly atGate?: boolean } = {}
): Promise<unknown> {
  const atGate = route.useVaultModel || options.atGate === true;
  try {
    if (!atGate) return await route.modelProvider(request, signal);
    return await route.modelGate.call(
      {
        tenantId: route.tenantId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        agentId: request.agentId,
        effectId: request.effectId,
        invocationId: String(request.context.invocationId),
        call: request.input as RuntimeModelCall,
      },
      signal
    );
  } catch (error) {
    if (signal.aborted) {
      // A call that outlives this process stops only when told to: on a user cancel. After a
      // shutdown or a lost lease the next owner re-sends it and picks up its outcome (P1.2).
      if (atGate && runAbortKind(signal) === "cancel" && route.modelGate.cancel)
        await route.modelGate.cancel({
          tenantId: route.tenantId,
          sessionId: request.sessionId,
          effectId: request.effectId,
        });
      throw error;
    }
    return classifyThrown(error);
  }
}

/**
 * A signal that follows `signal` only for the abort kinds in `kinds`. An MCP call stops on a
 * cancel; at the Tool Gate it also stops waiting on a shutdown, since the gate keeps the call
 * for the next owner. Otherwise a shutdown or a deadline lets the call finish and records it,
 * so the next advance replays it.
 */
export function abortOn(signal: AbortSignal, kinds: readonly AbortReason[]): AbortSignal {
  const controller = new AbortController();
  const follow = () => {
    const kind = runAbortKind(signal);
    if (kind && kinds.includes(kind)) controller.abort(signal.reason);
  };
  if (signal.aborted) follow();
  else signal.addEventListener("abort", follow, { once: true });
  return controller.signal;
}

/**
 * True when `request` calls a tool of an MCP server its agent declares (every one is remote): an
 * `mcp` call, by its target's `server` (protocol 15).
 */
export function isRemoteMcpCall(routing: Pick<ToolRouting, "rootManifest">, request: HostEffect): boolean {
  if (request.kind !== "tool" || request.target?.kind !== "mcp") return false;
  return findServer(routing.rootManifest, request.agent?.id, request.target.server) !== undefined;
}

export async function callMcpTool(
  mcp: McpPool,
  routing: ToolRouting,
  request: HostEffect,
  signal: AbortSignal,
  /** The run's Runtime limit `toolAnswerBytes`: the largest answer kept where this process holds the connection. */
  maxResultBytes: number,
  /** The call's span context (R7.4), sent as `traceparent` where this process holds the connection. */
  traceparent?: string
): Promise<unknown> {
  // The call names its tool by its identity (protocol 15): the server, and its own name there.
  const target = request.target;
  if (target?.kind !== "mcp") throw new Error(`'${request.toolName ?? ""}' is not an MCP tool call`);
  return mcp.call({
    sessionId: request.sessionId,
    ...(request.agent === undefined ? {} : { agentId: request.agent.id }),
    serverName: target.server,
    serverToolName: target.tool,
    args: request.input,
    manifest: routing.rootManifest,
    effectId: request.effectId,
    ...(traceparent ? { traceparent } : {}),
    maxResultBytes,
    signal,
  });
}

/**
 * Calls an HTTP tool through the Tool Gate (R2 M3), keyed by the effect id: an agent's (the
 * effect's agent used as a tool, or the root), or a flow's HTTP stage or HTTP verifier. Its
 * outcome is the effect's value; a throw leaves the effect `uncertain`.
 */
export async function callHttpTool(
  gate: Pick<ToolGate, "callHttp">,
  request: HostEffect,
  signal: AbortSignal,
  /** The call's span context (R7.4); the gates service reads its own from the journal. */
  traceparent?: string
): Promise<unknown> {
  if (!gate.callHttp) throw new Error("This Runtime has no Tool Gate for HTTP tools");
  return gate.callHttp(
    {
      tool: httpToolRefOf(request),
      effectId: request.effectId,
      turnId: request.turnId,
      input: request.input,
      ...(traceparent ? { traceparent } : {}),
    },
    signal
  );
}

/**
 * Runs a `sandbox` call: the operation it names, in the session's sandbox (the one its agents
 * used as tools share), held to the harness's sandbox tool limits.
 */
export async function callSandboxTool(
  sandbox: SandboxManager,
  routing: ToolRouting,
  request: HostEffect,
  signal: AbortSignal,
  limits?: SandboxToolLimits
): Promise<unknown> {
  const { spec } = routing;
  if (!spec) throw new Error(`This session has no sandbox to run '${request.toolName ?? ""}' in`);
  if (request.toolName === undefined || !isSandboxToolName(request.toolName))
    throw new Error(`'${request.toolName ?? ""}' is not a sandbox operation`);
  return sandbox.run(
    {
      id: routing.sandboxOwnerId,
      activeTurnId: routing.activeTurnId,
      manifest: routing.rootManifest,
      ...(routing.environmentId === undefined ? {} : { environmentId: routing.environmentId }),
      ...(routing.environment === undefined ? {} : { environment: routing.environment }),
      ...(routing.claim === undefined ? {} : { claim: routing.claim }),
    },
    spec,
    request.toolName,
    request.input,
    signal,
    limits
  );
}
