/**
 * The executors of an in-process harness: the Tenant's own Model Gate, MCP pool and
 * SandboxManager, injected. They reach no store: a run's routing comes with its `turn.start`.
 */
import type { AgentManifest } from "@nylorun/core/define";
import type { HarnessExecutors, HarnessRun } from "@nylorun/harness/api";
import { toolFixtureModel } from "../core/provider.js";
import type { ToolGate } from "../gates/tool-gate.js";
import type { McpPool } from "../mcp/pool.js";
import { mcpToolOf, type McpSnapshot } from "../mcp/snapshot.js";
import type { SandboxManager } from "../sandbox/manager.js";
import {
  abortOn,
  callMcpTool,
  callSandboxTool,
  invokeModel,
  isRemoteMcpCall,
  type ModelRoute,
  type ToolRouting,
} from "./calls.js";

export interface InProcessExecutorsOptions extends ModelRoute {
  readonly toolGate: ToolGate;
  readonly mcp: McpPool;
  readonly sandbox: SandboxManager;
}

/** The Tenant's model of the fixture-model setting. Stateless. */
const fixture = toolFixtureModel();

export function inProcessExecutors(options: InProcessExecutorsOptions): HarnessExecutors {
  const recoversMcp = options.toolGate.recovers === true;
  const remote = (effect: Parameters<HarnessExecutors["tool"]>[0], run: HarnessRun) =>
    recoversMcp && isRemoteMcpCall(routingOf(run), effect);
  return {
    model: (effect, signal, run) =>
      invokeModel(options, effect, signal, run.start.options.fixtureModel ? fixture : undefined),
    tool(effect, signal, run) {
      const routing = routingOf(run);
      if (!mcpToolOf(routing.mcpSnapshot, effect))
        return callSandboxTool(options.sandbox, routing, effect, signal);
      // A call at the Tool Gate outlives a shutdown there; a local one finishes and is recorded.
      const kinds = remote(effect, run) ? (["cancel", "shutdown"] as const) : (["cancel"] as const);
      return callMcpTool(options.mcp, routing, effect, abortOn(signal, kinds));
    },
    recovers: {
      model: options.useVaultModel && options.modelGate.recovers === true,
      remoteMcp: remote,
    },
    async cancelAtGate(effect) {
      await options.toolGate.cancel?.({
        tenantId: options.tenantId,
        sessionId: effect.sessionId,
        effectId: effect.effectId,
      });
    },
  };
}

/** A run's routing, as the call helpers take it. */
export function routingOf(run: HarnessRun): ToolRouting {
  const { routing } = run.start;
  return {
    rootManifest: routing.rootManifest as AgentManifest,
    pluginRoots: routing.pluginRoots,
    ...(routing.mcpSnapshot ? { mcpSnapshot: routing.mcpSnapshot as McpSnapshot } : {}),
    sandboxOwnerId: routing.sandbox?.ownerId ?? run.grant.sessionId,
    ...(routing.sandbox?.sandboxId === undefined ? {} : { sandboxId: routing.sandbox.sandboxId }),
    activeTurnId: run.grant.turnId,
  };
}
