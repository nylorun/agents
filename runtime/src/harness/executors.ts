/**
 * A harness's executors (F6.1, F6.2): the model route, the Tool Gate (remote MCP and HTTP
 * tools), an MCP pool and a SandboxManager, injected. They reach no store: a run's routing comes
 * with its `turn.start`, and the session's MCP discovery is recorded through core (`session.mcp`,
 * `prepare`).
 *
 * The in-process harness gets the Tenant's own pool and SandboxManager; a harness process
 * (`--service harness`, `main.ts`) its own, whose sandbox events it claims from core.
 */
import { hashManifest, type AgentManifest } from "@nylorun/core/define";
import type { HarnessExecutors, HarnessRun, McpRecorder, PreparedRun } from "@nylorun/harness/api";
import type { DurableSessionTool } from "@nylorun/harness/run";
import { toolFixtureModel } from "../core/provider.js";
import type { ToolGate } from "../gates/tool-gate.js";
import { serversOf, type McpPool } from "../mcp/pool.js";
import { mcpToolOf, type McpSnapshot } from "../mcp/snapshot.js";
import type { SandboxManager } from "../sandbox/manager.js";
import { isHttpToolCall } from "../gates/http-tool.js";
import {
  abortOn,
  callHttpTool,
  callMcpTool,
  callSandboxTool,
  invokeModel,
  isRemoteMcpCall,
  isSaveArtifactCall,
  type ModelRoute,
  type ToolRouting,
} from "./calls.js";

export interface HarnessExecutorsOptions {
  /** Where model calls go. Read per call: a harness process learns its Tenant at `hello`. */
  readonly model: ModelRoute;
  readonly toolGate: Pick<ToolGate, "recovers" | "cancel" | "callHttp">;
  readonly mcp: McpPool;
  /** The SandboxManager; a harness process creates it once `hello` names the Tenant. */
  readonly sandbox: () => SandboxManager;
}

/** The Tenant's model of the fixture-model setting. Stateless. */
const fixture = toolFixtureModel();

export function harnessExecutors(options: HarnessExecutorsOptions): HarnessExecutors {
  const recoversTools = options.toolGate.recovers === true;
  const atGate = (effect: Parameters<HarnessExecutors["tool"]>[0], run: HarnessRun) => {
    const routing = routingOf(run);
    return isRemoteMcpCall(routing, effect) || isHttpToolCall(routing.rootManifest, effect);
  };
  const recovered = (effect: Parameters<HarnessExecutors["tool"]>[0], run: HarnessRun) =>
    recoversTools && atGate(effect, run);
  return {
    model: (effect, signal, run) =>
      invokeModel(options.model, effect, signal, run.start.options.fixtureModel ? fixture : undefined),
    tool(effect, signal, run) {
      const routing = routingOf(run);
      // A call at the Tool Gate outlives a shutdown there; a local one finishes and is recorded.
      const kinds = recovered(effect, run) ? (["cancel", "shutdown"] as const) : (["cancel"] as const);
      if (isHttpToolCall(routing.rootManifest, effect))
        return callHttpTool(options.toolGate, effect, abortOn(signal, kinds));
      if (!mcpToolOf(routing.mcpSnapshot, effect))
        return callSandboxTool(options.sandbox(), routing, effect, signal);
      return callMcpTool(options.mcp, routing, effect, abortOn(signal, kinds));
    },
    recovers: {
      get model() {
        return options.model.useVaultModel && options.model.modelGate.recovers === true;
      },
      tool: recovered,
    },
    async cancelAtGate(effect) {
      await options.toolGate.cancel?.({
        tenantId: options.model.tenantId,
        sessionId: effect.sessionId,
        effectId: effect.effectId,
      });
    },
    prepare: (run, record) => prepareMcp(options.mcp, run, record),
  };
}

/**
 * Readies the run's MCP servers (§10.5 step 3): the first segment of a session discovers their
 * tools and records the snapshot (the first recorded wins); later ones reconnect them and record
 * what failed. Nothing for a session without MCP servers.
 */
export async function prepareMcp(
  pool: McpPool,
  run: HarnessRun,
  record: McpRecorder
): Promise<PreparedRun | undefined> {
  const routing = routingOf(run);
  const manifest = routing.rootManifest;
  if (serversOf(manifest).length === 0) return undefined;
  const sessionId = run.grant.sessionId;
  let answer: Awaited<ReturnType<McpRecorder>>;
  if (!routing.mcpSnapshot) {
    const found = await pool.discover({
      sessionId,
      manifest,
      manifestHash: hashManifest(manifest),
      pluginRoots: routing.pluginRoots,
      signal: run.signal,
    });
    answer = await record({ snapshot: found.snapshot, diagnostics: found.diagnostics });
  } else {
    const diagnostics = await pool.reconnect({
      sessionId,
      manifest,
      pluginRoots: routing.pluginRoots,
      tools: routing.mcpSnapshot.mcpTools,
      signal: run.signal,
    });
    if (diagnostics.length === 0) return undefined;
    answer = await record({ diagnostics });
  }
  return {
    sessionTools: answer.sessionTools as DurableSessionTool[],
    ...(answer.snapshot === undefined ? {} : { mcpSnapshot: answer.snapshot }),
  };
}

/** A run's routing, as the call helpers take it. Its sandbox events are claimed for the run. */
export function routingOf(run: HarnessRun): ToolRouting {
  const { routing } = run.start;
  return {
    rootManifest: routing.rootManifest as AgentManifest,
    pluginRoots: routing.pluginRoots,
    ...(routing.mcpSnapshot ? { mcpSnapshot: routing.mcpSnapshot as McpSnapshot } : {}),
    sandboxOwnerId: routing.sandbox?.ownerId ?? run.grant.sessionId,
    ...(routing.sandbox?.sandboxId === undefined ? {} : { sandboxId: routing.sandbox.sandboxId }),
    activeTurnId: run.grant.turnId,
    claim: run.runId,
  };
}
