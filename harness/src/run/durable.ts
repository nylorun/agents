import { HarnessError } from "@nylorun/core/define";
import type { AgentManifest } from "@nylorun/core/define";
import type { ExecutionInput, ExecutionState, RunResult } from "../types/execution.js";
import type { JsonObject, JsonValue } from "@nylorun/core/define";
import type { Implementations } from "@nylorun/core/define";
import type { EffectOutcome } from "@nylorun/core/contracts";
import type { AgentRef, ApprovalMode, ModelAdapter } from "@nylorun/core/define";
import type { DelegationHost } from "../loop/delegation.js";
import type { AgentDefinition } from "../definition/agent-definition.js";
import { AgentManifestSchema } from "@nylorun/core/contracts";
import {
  TOOL_CALL_TOOL,
  TOOLS_CAPABILITY_ID,
  agentFrom,
  withHttpTarget,
} from "@nylorun/core/define";
import { definitionFor } from "../definition/agent-definition.js";
import { schemaFromJSON } from "@nylorun/core/define";
import { hashManifest } from "@nylorun/core/define";
import { withDeterministicIds } from "../utils/ids.js";
import { execute } from "../loop/run.js";
import { initializeExecutionState } from "../loop/initial-state.js";
import { HostSuspension } from "../loop/host-suspension.js";
import { CHECKPOINT_VERSION, ENGINE_VERSION } from "../compatibility.js";

/** Private persistence contract for hosts; this is not a session wire type. */
export interface DurableCheckpoint {
  readonly version: 1;
  readonly engineVersion: typeof ENGINE_VERSION;
  readonly manifestHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Increment for each human/event continuation, not for an action result. */
  readonly segment: number;
  readonly input: ExecutionInput;
  readonly state?: ExecutionState;
  readonly info?: JsonObject;
}
export interface HostEffect {
  readonly effectId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly manifestHash: string;
  /**
   * `delegation` journals when an agent used as a tool starts and settles; hosts record it and resolve it at once.
   * Flow effects: `agent` and `tool` (node) — each carries `path`, `key`, and `iterations`.
   */
  readonly kind: "model" | "tool" | "delegation" | "agent";
  /** Set on work for an agent used as a tool; `agentId` stays the session's root agent. */
  readonly agent?: AgentRef;
  readonly capabilityId?: string;
  readonly toolName?: string;
  /** Workflow node path (flow effects). */
  readonly path?: string;
  /** Workflow node key without Map indices (flow effects). */
  readonly key?: string;
  /** Iteration vector of enclosing Loops, outermost first (e.g. `"3"`, `"2.1"`); `"-"` outside Loops. */
  readonly iterations?: string;
  readonly input: unknown;
  readonly context: Record<string, unknown>;
}
export type EffectResolution =
  | { readonly status: "completed"; readonly outcome: EffectOutcome }
  | { readonly status: "pending" | "uncertain" };
export interface DurableHost {
  /** Atomically load-or-create by effectId; validate identical request on replay.
   * Return recorded outcomes. Record intent BEFORE invoking a provider or exposing
   * customer work. Uncertain effects must never be automatically executed again.
   */
  resolveEffect(effect: HostEffect): Promise<EffectResolution>;
}
export type DurableResult =
  | {
      readonly status: "waiting" | "uncertain";
      readonly checkpoint: DurableCheckpoint;
      readonly effectIds: readonly string[];
    }
  | {
      readonly status: "completed" | "paused" | "cancelled" | "failed" | "yielded";
      readonly checkpoint: DurableCheckpoint;
      readonly result: RunResult<unknown>;
    };
/** Discovered tool advertised for this execution. It is not part of the hashed manifest. */
export interface DurableSessionTool {
  /** The agent used as a tool that owns this tool; absent for the root agent. */
  readonly agentId?: string;
  readonly capabilityId: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /** `always`: each call waits for approval (a remote MCP server's, or its tool's, `approval`). */
  readonly approval?: ApprovalMode;
  /**
   * Not in the model's tool list (R2b C10): the model finds it with `tool_search` and runs it
   * with `tool_call`, which makes the call as this tool's own.
   */
  readonly deferred?: boolean;
  /** Text the model reads with the capability's instructions while this tool is advertised. */
  readonly instructions?: readonly string[];
}
export function createDurableCheckpoint(input: {
  manifest: AgentManifest;
  sessionId: string;
  turnId: string;
  input: ExecutionInput;
  state?: ExecutionState;
  info?: JsonObject;
  segment?: number;
}): DurableCheckpoint {
  AgentManifestSchema.parse(input.manifest);
  return {
    version: CHECKPOINT_VERSION,
    engineVersion: ENGINE_VERSION,
    manifestHash: hashManifest(input.manifest),
    sessionId: input.sessionId,
    turnId: input.turnId,
    segment: input.segment ?? 0,
    input: input.input,
    ...(input.state ? { state: input.state } : {}),
    ...(input.info ? { info: input.info } : {}),
  };
}
/** Deterministic reconstruction uses individually journaled effects, never a replayable whole loop.
 * A suspended checkpoint is the immutable segment start plus the host's durable effect journal.
 * Returning waiting releases all execution stacks; no process-local continuation survives.
 */
export async function runDurable(options: {
  manifest: AgentManifest;
  checkpoint: DurableCheckpoint;
  host: DurableHost;
  signal?: AbortSignal;
  sessionTools?: readonly DurableSessionTool[];
  /** Segment rollover (Model Calls §10): yield after this many steps or milliseconds. */
  yieldAfter?: { readonly steps?: number; readonly ms?: number };
}): Promise<DurableResult> {
  const { manifest, checkpoint, host } = options;
  AgentManifestSchema.parse(manifest);
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    checkpoint.engineVersion !== ENGINE_VERSION ||
    checkpoint.manifestHash !== hashManifest(manifest)
  )
    throw new HarnessError("execution.incompatible", "Incompatible durable checkpoint");
  if (
    checkpoint.state &&
    (checkpoint.state.manifestHash !== checkpoint.manifestHash ||
      checkpoint.state.agentId !== manifest.id ||
      checkpoint.state.executionId !== checkpoint.sessionId)
  )
    throw new HarnessError("execution.incompatible", "Checkpoint definition/session mismatch");
  const pending = new Map<string, "pending" | "uncertain">();
  const inFlight = new Set<Promise<unknown>>();
  // Effect ids are derived from stable names, never call order, so replays line up.
  const effect = async (
    kind: HostEffect["kind"],
    input: unknown,
    context: Record<string, unknown>,
    identity: string,
    target: Pick<HostEffect, "capabilityId" | "toolName" | "agent"> = {},
  ): Promise<EffectOutcome> => {
    const effectId = `${checkpoint.turnId}:${checkpoint.segment}:${kind}:${identity}`;
    const request: HostEffect = JSON.parse(
      JSON.stringify({
        effectId,
        sessionId: checkpoint.sessionId,
        turnId: checkpoint.turnId,
        agentId: manifest.id,
        manifestHash: checkpoint.manifestHash,
        kind,
        input,
        context,
        ...target,
      }),
    );
    const operation = host.resolveEffect(request);
    inFlight.add(operation);
    let result: EffectResolution;
    try {
      result = await operation;
    } finally {
      inFlight.delete(operation);
    }
    if (result.status !== "completed") {
      pending.set(effectId, result.status);
      throw new HostSuspension(effectId, result.status);
    }
    return result.outcome;
  };
  /** Tools of one agent. Each agent keeps its own patch order; children namespace their effects. */
  const hostedTools = (ref?: AgentRef) => {
    let patchTail: Promise<void> = Promise.resolve();
    return (
      capabilityId: string,
      tool: {
        readonly name: string;
        readonly description?: string;
        readonly inputSchema: JsonObject;
        readonly outputSchema?: JsonObject;
        readonly approval?: ApprovalMode;
      },
    ) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: schemaFromJSON(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: schemaFromJSON(tool.outputSchema) } : {}),
      // Static approval: the engine asks before the call becomes an effect.
      ...(tool.approval === "always" ? { approval: () => true } : {}),
      async execute(args: unknown, ctx: any) {
        const previous = patchTail;
        let release!: () => void;
        patchTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          const outcome = await effect(
            "tool",
            args,
            {
              executionId: ctx.executionId,
              turnId: ctx.turnId,
              stepId: ctx.stepId,
              callId: ctx.callId,
              invocationId: ctx.invocationId,
              idempotencyKey: ref
                ? `${ref.delegationId}/${ctx.idempotencyKey}`
                : ctx.idempotencyKey,
              info: ctx.info,
              state: ctx.state.entries(),
              resume: ctx.resume,
            },
            scoped(ref, ctx.invocationId),
            { capabilityId, toolName: tool.name, ...(ref ? { agent: ref } : {}) },
          );
          // Apply concurrently resolved patches in manifest call order, independent of host I/O timing.
          await previous;
          for (const [key, value] of Object.entries(outcome.statePatch ?? {}))
            ctx.state.set(key, value);
          const value = outcome.value as any;
          return value?.kind === "interaction-required"
            ? {
                ...value,
                interaction: {
                  ...value.interaction,
                  id: `${checkpoint.turnId}:${checkpoint.segment}:interaction:${ctx.invocationId}`,
                },
              }
            : value;
        } finally {
          await previous;
          release();
        }
      },
    });
  };
  const sessionTools = options.sessionTools ?? [];
  /** Rebuild one agent from its manifest with every tool routed through host effects. */
  const hostedDefinition = (agent: AgentManifest, ref?: AgentRef): AgentDefinition => {
    const hostedTool = hostedTools(ref);
    const mine = sessionTools.filter((tool) => (tool.agentId ?? manifest.id) === agent.id);
    // Deferred tools stay out of the model's list; `tool_call` runs them (R2b C10).
    const owned = mine.filter((tool) => !tool.deferred);
    const deferred = new Map(mine.filter((tool) => tool.deferred).map((tool) => [tool.name, tool]));
    const implementations: Record<string, Implementations[string]> = {};
    for (const capability of agent.capabilities) {
      const tools: Record<string, any> = {};
      // Agents used as tools are rebuilt from their manifest body; the engine runs them. An
      // HTTP tool keeps its target (the manifest's hash covers it) and runs as a host effect.
      for (const tool of capability.tools ?? [])
        if (tool.http)
          tools[tool.name] = withHttpTarget(hostedTool(capability.id, tool), {
            http: tool.http,
            ...(tool.approval === undefined ? {} : { approval: tool.approval }),
          });
        else if (!tool.agent) tools[tool.name] = hostedTool(capability.id, tool);
      for (const tool of owned)
        if (tool.capabilityId === capability.id)
          tools[tool.name] =
            capability.id === TOOLS_CAPABILITY_ID && tool.name === TOOL_CALL_TOOL
              ? deferredToolCall(tool, deferred, hostedTool)
              : hostedTool(capability.id, tool);
      implementations[capability.id] = { tools };
    }
    return definitionFor(
      agentFrom(
        agent,
        implementations,
        owned.length === 0
          ? undefined
          : {
              sessionTools: owned.map((tool) => ({
                capabilityId: tool.capabilityId,
                name: tool.name,
                ...(tool.instructions?.length ? { instructions: tool.instructions } : {}),
              })),
            },
      ),
    );
  };
  const modelCall =
    (ref?: AgentRef): ModelAdapter =>
    async (call, ctx) =>
      (
        await effect(
          "model",
          call,
          // The call already holds the whole prompt; journaling the request would store it twice.
          {
            invocationId: ctx.invocationId,
            ...(ctx.compaction ? { compaction: ctx.compaction } : {}),
          },
          scoped(ref, ctx.invocationId),
          ref ? { agent: ref } : {},
        )
      ).value as any;
  const delegation: DelegationHost = {
    child: (delegate, ref) => ({
      definition: hostedDefinition(delegate.manifest as AgentManifest, ref),
      onModelCall: modelCall(ref),
    }),
    // A flow agent used as a tool runs in its own linked session, like a flow's agent
    // step: the host starts it, and the effect settles when its turn ends.
    async flow(_delegate, ref, task) {
      const outcome = await effect(
        "agent",
        { agentId: ref.id, input: task, path: ref.path },
        { role: "delegate", delegationId: ref.delegationId },
        `${ref.delegationId}:flow`,
        { agent: ref },
      );
      return outcome.value as JsonValue;
    },
    async announce(phase, ref, payload, ids) {
      await effect("delegation", payload, { ...ids }, `${ref.delegationId}:${phase}`, {
        agent: ref,
      });
    },
  };
  const hosted = hostedDefinition(manifest);
  // Manifest reconstruction must retain definition identity, including schemas and instructions.
  if (hosted.hash !== checkpoint.manifestHash)
    throw new HarnessError("execution.incompatible", "Reconstructed definition hash mismatch");
  try {
    const result = await withDeterministicIds(`${checkpoint.turnId}_${checkpoint.segment}`, () =>
      execute(
        hosted,
        {
          state:
            checkpoint.state ??
            initializeExecutionState(hosted, { executionId: checkpoint.sessionId }),
          input: checkpoint.input,
          info: checkpoint.info,
          signal: options.signal,
          onModelCall: modelCall(),
        },
        { delegation, ...(options.yieldAfter ? { yieldAfter: options.yieldAfter } : {}) },
      ),
    );
    return { status: result.status, checkpoint: { ...checkpoint, state: result.state }, result };
  } catch (error) {
    // Parallel tool dispatch can suspend more than one action. Drain persistence before returning.
    await Promise.allSettled([...inFlight]);
    if (!(error instanceof HostSuspension)) throw error;
    return {
      status: [...pending.values()].includes("uncertain") ? "uncertain" : "waiting",
      checkpoint,
      effectIds: [...pending.keys()],
    };
  }
}

/** Effect identities of an agent used as a tool live under its delegation. */
function scoped(ref: AgentRef | undefined, identity: string): string {
  return ref ? `${ref.delegationId}/${identity}` : identity;
}

type HostedTool = (
  capabilityId: string,
  tool: DurableSessionTool,
) => { execute(args: unknown, ctx: unknown): Promise<unknown> };

/**
 * `tool_call` (R2b C10): runs a deferred tool by name, as that tool's own call. It checks the
 * arguments against the tool's `inputSchema` first, so a mistake comes back to the model as a
 * failed result it can fix. The effect then names the tool, so the host routes it, shapes its
 * result and records `tool.completed` as for a direct call; a tool with approval waits for it
 * here, with the prompt a direct call would have.
 */
function deferredToolCall(
  tool: DurableSessionTool,
  deferred: ReadonlyMap<string, DurableSessionTool>,
  hostedTool: HostedTool,
) {
  const hosted = new Map<string, ReturnType<HostedTool>>();
  const targetOf = (args: unknown) => {
    const name = (args as { name?: unknown } | undefined)?.name;
    return typeof name === "string" ? deferred.get(name) : undefined;
  };
  const gated = [...deferred.values()].some((item) => item.approval === "always");
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: schemaFromJSON(tool.inputSchema),
    ...(gated
      ? {
          approval: (args: unknown) => {
            const target = targetOf(args);
            return target?.approval === "always" ? `Approve ${target.name}?` : undefined;
          },
        }
      : {}),
    async execute(args: unknown, ctx: unknown) {
      const call = args as { name: string; arguments?: Record<string, unknown> };
      const target = targetOf(call);
      if (!target)
        return {
          kind: "failed",
          code: "tool.unknown",
          message: `No deferred tool is named '${call.name}'. Find one with tool_search, and pass its name as it returned it.`,
        };
      const checked = schemaFromJSON(target.inputSchema).validate(call.arguments ?? {});
      if (!checked.ok)
        return {
          kind: "failed",
          code: "tool.invalid-arguments",
          message: `The arguments do not match the inputSchema of '${target.name}': ${checked.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        };
      let run = hosted.get(target.name);
      if (!run) {
        run = hostedTool(target.capabilityId, target);
        hosted.set(target.name, run);
      }
      return run.execute(checked.value, ctx);
    },
  };
}
