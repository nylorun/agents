/**
 * A harness's executors (F6.1, F6.2): the model route, the Tool Gate (remote MCP and HTTP
 * tools), an MCP pool and a SandboxManager, injected. They reach no store: a run's routing comes
 * with its `turn.start`, and the session's MCP discovery is recorded through core (`session.mcp`,
 * `prepare`).
 *
 * The in-process harness gets the Tenant's own pool and SandboxManager; a harness process
 * (`--service harness`, `main.ts`) its own, whose sandbox events it claims from core.
 */
import { hashManifest, type AgentManifest, type SandboxManifest } from "@nylorun/core/define";
import { sandboxToolLimitsOf, type SandboxToolLimits } from "@nylorun/harness";
import type { HarnessExecutors, HarnessRun, McpRecorder, PreparedRun } from "@nylorun/harness/api";
import type { DurableSessionTool } from "@nylorun/harness/run";
import type { ToolGate } from "../gates/tool-gate.js";
import { GateCallLost } from "../gates/tool-client.js";
import { serversOf, type McpPool } from "../mcp/pool.js";
import type { McpSnapshot } from "../mcp/snapshot.js";
import type { SandboxManager, SandboxSessionRef } from "../sandbox/manager.js";
import { isHttpToolCall } from "../gates/http-tool.js";
import {
  abortOn,
  callHttpTool,
  callMcpTool,
  callSandboxTool,
  invokeModel,
  isRemoteMcpCall,
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
  /**
   * The sandbox tools' limits the calls run with: the harness's configuration, the same it gives
   * `createHarness({ sandboxTools })`. Each left out is its default.
   */
  readonly sandboxTools?: Partial<SandboxToolLimits>;
}

export function harnessExecutors(options: HarnessExecutorsOptions): HarnessExecutors {
  const recoversTools = options.toolGate.recovers === true;
  const sandboxTools = sandboxToolLimitsOf(options.sandboxTools);
  const atGate = (effect: Parameters<HarnessExecutors["tool"]>[0], run: HarnessRun) => {
    const routing = routingOf(run);
    return isRemoteMcpCall(routing, effect) || isHttpToolCall(routing.rootManifest, effect);
  };
  const recovered = (effect: Parameters<HarnessExecutors["tool"]>[0], run: HarnessRun) =>
    recoversTools && atGate(effect, run);
  return {
    // With the Tenant's fixture model on, the Model Gate answers it (R4.3), metered like any call.
    model: (effect, signal, run) =>
      invokeModel(options.model, effect, signal, { atGate: run.start.options.fixtureModel }),
    tool(effect, signal, run, call) {
      const routing = routingOf(run);
      const traceparent = call?.traceparent;
      // A call at the Tool Gate outlives a shutdown there; a local one finishes and is recorded.
      const kinds = recovered(effect, run) ? (["cancel", "shutdown"] as const) : (["cancel"] as const);
      // A call is routed by what it names as its target (protocol 15); a flow's HTTP stage names
      // its stage.
      if (isHttpToolCall(routing.rootManifest, effect))
        return callHttpTool(options.toolGate, effect, abortOn(signal, kinds), traceparent);
      // A sandbox command joins its call's span (R7.4): a CLI that reads TRACEPARENT traces under it.
      if (effect.target?.kind === "sandbox")
        return callSandboxTool(
          options.sandbox(),
          traceparent ? { ...routing, environment: { ...routing.environment, TRACEPARENT: traceparent } } : routing,
          effect,
          signal,
          sandboxTools
        );
      if (effect.target?.kind !== "mcp")
        throw new Error(`This harness runs no ${effect.target?.kind ?? "untargeted"} call of '${effect.toolName ?? ""}'`);
      return callMcpTool(
        options.mcp,
        routing,
        effect,
        abortOn(signal, kinds),
        run.start.limits.toolAnswerBytes,
        traceparent
      );
    },
    recovers: {
      get model() {
        return options.model.useVaultModel && options.model.modelGate.recovers === true;
      },
      tool: recovered,
    },
    // A gate hop that lost the answer: the call is sent again with its key (R5.3).
    resends: (effect, error, run) => error instanceof GateCallLost && atGate(effect, run),
    async cancelAtGate(effect) {
      await options.toolGate.cancel?.({
        tenantId: options.model.tenantId,
        sessionId: effect.sessionId,
        effectId: effect.effectId,
      });
    },
    prepare: (run, record) => prepareMcp(options.mcp, run, record),
    files: {
      read: (run, path, maxBytes, signal) =>
        withSandbox(run, (session, spec) => options.sandbox().readBytes(session, spec, path, maxBytes, signal)),
      write: (run, path, body, signal) =>
        withSandbox(run, (session, spec) => options.sandbox().writeBytes(session, spec, path, body, signal)),
    },
  };
}

/**
 * Runs `use` on the run's sandbox (the session's, which its agents used as tools share), or
 * answers `artifact.no_sandbox` for a session without one.
 */
async function withSandbox<T>(
  run: HarnessRun,
  use: (session: SandboxSessionRef, spec: SandboxManifest) => Promise<T>
): Promise<T | { kind: "failed"; code: string; message: string }> {
  const routing = routingOf(run);
  const { spec } = routing;
  if (spec === undefined)
    return { kind: "failed", code: "artifact.no_sandbox", message: "This session has no sandbox." };
  return use(
    {
      id: routing.sandboxOwnerId,
      activeTurnId: routing.activeTurnId,
      manifest: routing.rootManifest,
      ...(routing.environmentId === undefined ? {} : { environmentId: routing.environmentId }),
      ...(routing.claim === undefined ? {} : { claim: routing.claim }),
    },
    spec
  );
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
      signal: run.signal,
    });
    answer = await record({ snapshot: found.snapshot, diagnostics: found.diagnostics });
  } else {
    const diagnostics = await pool.reconnect({
      sessionId,
      manifest,
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
    ...(routing.mcpSnapshot ? { mcpSnapshot: routing.mcpSnapshot as McpSnapshot } : {}),
    sandboxOwnerId: routing.sandbox?.ownerId ?? run.grant.sessionId,
    ...(routing.sandbox?.spec === undefined ? {} : { spec: routing.sandbox.spec as SandboxManifest }),
    ...(routing.sandbox?.environmentId === undefined ? {} : { environmentId: routing.sandbox.environmentId }),
    ...(routing.sandbox?.environment === undefined ? {} : { environment: routing.sandbox.environment }),
    activeTurnId: run.grant.turnId,
    claim: run.runId,
  };
}
