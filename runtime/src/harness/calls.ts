/**
 * The calls a harness executes, as pure helpers over what routes them: the Model Gate (or the
 * Tenant's provider), the Tool Gate, the MCP pool, the SandboxManager. No store, no record: the
 * session's routing comes with the run (`TurnStart.routing`).
 */
import {
  ARTIFACTS_CAPABILITY_ID,
  READ_ARTIFACT_TOOL,
  SAVE_ARTIFACT_TOOL,
  type AgentManifest,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { runAbortKind } from "@nylorun/harness/api";
import type { AbortReason } from "@nylorun/core/harness-api";
import type { RuntimeModelCall } from "../contracts.js";
import type { ModelProvider } from "../core/provider.js";
import type { ModelGate } from "../gates/model-gate.js";
import type { ToolGate } from "../gates/tool-gate.js";
import { httpToolRefOf } from "../gates/http-tool.js";
import { classifyThrown } from "../model/classify.js";
import { findServer, type McpPool } from "../mcp/pool.js";
import { manifestFor, mcpToolOf, type McpSnapshot } from "../mcp/snapshot.js";
import { sandboxCapabilityOf } from "../sandbox/capability.js";
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
  readonly mcpSnapshot?: McpSnapshot;
  /** The session that owns the tree's sandbox, and the sandbox resource it is attached to. */
  readonly sandboxOwnerId: string;
  readonly sandboxId?: string;
  readonly activeTurnId: string | null;
  /** Who the sandbox call's events are claimed for: the run's id. */
  readonly claim?: string;
}

/**
 * Call the model for one effect. A provider failure comes back as a failure outcome
 * (Model Calls §6), whichever provider serves the call; only an abort throws, and the
 * advance decides what the abort means.
 */
export async function invokeModel(
  route: ModelRoute,
  request: HostEffect,
  signal: AbortSignal,
  model?: ModelProvider
): Promise<unknown> {
  try {
    if (model) return await model(request, signal);
    if (!route.useVaultModel) return await route.modelProvider(request, signal);
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
      if (!model && route.useVaultModel && runAbortKind(signal) === "cancel" && route.modelGate.cancel)
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

/** True when `request` calls `save_artifact` of the `nylorun.artifacts` capability `manifest` has. */
export function isSaveArtifactCall(manifest: AgentManifest | undefined, request: HostEffect): boolean {
  return isArtifactsToolCall(manifest, request, SAVE_ARTIFACT_TOOL);
}

/** True when `request` calls `read_artifact` (R2b C11) of the `nylorun.artifacts` capability. */
export function isReadArtifactCall(manifest: AgentManifest | undefined, request: HostEffect): boolean {
  return isArtifactsToolCall(manifest, request, READ_ARTIFACT_TOOL);
}

function isArtifactsToolCall(
  manifest: AgentManifest | undefined,
  request: HostEffect,
  toolName: string
): boolean {
  return (
    request.kind === "tool" &&
    request.capabilityId === ARTIFACTS_CAPABILITY_ID &&
    request.toolName === toolName &&
    manifest?.capabilities.some(
      (capability) =>
        capability.id === ARTIFACTS_CAPABILITY_ID &&
        capability.tools?.some((tool) => tool.name === toolName) === true
    ) === true
  );
}

/** True when `request` calls a tool of a declared MCP server (every one is remote). */
export function isRemoteMcpCall(
  routing: Pick<ToolRouting, "rootManifest" | "mcpSnapshot">,
  request: HostEffect
): boolean {
  if (request.kind !== "tool") return false;
  const tool = mcpToolOf(routing.mcpSnapshot, request);
  if (!tool) return false;
  return findServer(routing.rootManifest, tool.agentId, tool.capabilityId, tool.serverName) !== undefined;
}

export async function callMcpTool(
  mcp: McpPool,
  routing: ToolRouting,
  request: HostEffect,
  signal: AbortSignal
): Promise<unknown> {
  const tool = mcpToolOf(routing.mcpSnapshot, request);
  if (!tool)
    throw new Error(`MCP tool '${request.toolName ?? ""}' is not in the session snapshot`);
  return mcp.call({
    sessionId: request.sessionId,
    ...(tool.agentId === undefined ? {} : { agentId: tool.agentId }),
    capabilityId: tool.capabilityId,
    serverName: tool.serverName,
    serverToolName: tool.serverToolName,
    args: request.input,
    manifest: routing.rootManifest,
    effectId: request.effectId,
    // A read-only or idempotent tool's lost answer is the model's to retry (R2b C7, Q15).
    retrySafe: tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
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
  signal: AbortSignal
): Promise<unknown> {
  if (!gate.callHttp) throw new Error("This Runtime has no Tool Gate for HTTP tools");
  return gate.callHttp(
    { tool: httpToolRefOf(request), effectId: request.effectId, turnId: request.turnId, input: request.input },
    signal
  );
}

export async function callSandboxTool(
  sandbox: SandboxManager,
  routing: ToolRouting,
  request: HostEffect,
  signal: AbortSignal
): Promise<unknown> {
  const capability = sandboxCapabilityOf(
    manifestFor(routing.rootManifest, request.agent),
    request.capabilityId,
    request.toolName
  );
  if (!capability) throw new Error(`'${request.toolName ?? ""}' is not a sandbox tool`);
  // Agents used as tools share the session's sandbox; the tree declares one sandbox spec.
  return sandbox.run(
    {
      id: routing.sandboxOwnerId,
      activeTurnId: routing.activeTurnId,
      manifest: routing.rootManifest,
      ...(routing.sandboxId === undefined ? {} : { sandboxId: routing.sandboxId }),
      ...(routing.claim === undefined ? {} : { claim: routing.claim }),
    },
    capability,
    request.toolName as never,
    request.input,
    signal
  );
}
