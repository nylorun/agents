import { HarnessError } from "@nylorun/core/define";
import { effectIdOf, type EffectTarget, type ModelDescriptor } from "@nylorun/core/harness-api";
import type { FileContext } from "../loop/model/files.js";
import type { AgentManifest } from "@nylorun/core/define";
import type { ExecutionInput, ExecutionState, RunResult } from "../types/execution.js";
import type { JsonObject, JsonValue } from "@nylorun/core/define";
import type { Implementations } from "@nylorun/core/define";
import type { EffectOutcome } from "@nylorun/core/contracts";
import type { AgentRef, ModelAdapter } from "@nylorun/core/define";
import type { DelegationHost } from "../loop/delegation.js";
import type { AgentDefinition } from "../definition/agent-definition.js";
import { AgentManifestSchema, checkMemoryCall } from "@nylorun/core/contracts";
import { agentFrom, withHttpTarget } from "@nylorun/core/define";
import { TOOL_CALL_TOOL } from "../tools/tool-search.js";
import type { McpToolSet } from "../tools/mcp.js";
import { definitionFor } from "../definition/agent-definition.js";
import { schemaFromJSON } from "@nylorun/core/define";
import { hashManifest } from "@nylorun/core/define";
import { withDeterministicIds } from "../utils/ids.js";
import { skillOfToolCall } from "../tools/trace.js";
import type { EngineTools } from "../tools/engine-tools.js";
import { execute } from "../loop/run.js";
import { initializeExecutionState } from "../loop/initial-state.js";
import { HostSuspension } from "../loop/host-suspension.js";
import { CHECKPOINT_VERSION, ENGINE_VERSION } from "../compatibility.js";
import type { LoopConfig } from "../loop/config.js";

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
  /** The name the model called a tool by, for display; the record routes by `target`. */
  readonly toolName?: string;
  /**
   * What runs a tool call (protocol 15): an `mcp` tool by its identity (`server`, and `tool`, its
   * name on the server), an `http` tool by its declared name, a `sandbox` operation, or a
   * `harness` tool (ours, run here). An author's code tool has none: the record fails it to the
   * model.
   */
  readonly target?: EffectTarget;
  /** The skill the call ran, which the record keeps when the agent has that skill. */
  readonly skill?: string;
  /**
   * A model call that summarizes history for a compaction (protocol 15): the record writes no
   * assistant message for it, and the compaction's transcript edit names it.
   */
  readonly purpose?: "summary";
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
      /**
       * The root agent's summary calls of this segment, in order: the effects a compaction edit
       * of its transcript names (`CompactionFacts.summaryEffectIds`).
       */
      readonly summaryEffectIds?: readonly string[];
    };
/**
 * A tool our engine adds to an agent for this execution (an MCP tool of the session, one of our
 * engine's own). It is not part of the hashed manifest.
 */
export interface DurableSessionTool {
  /** The agent used as a tool that owns this tool; absent for the root agent. */
  readonly agentId?: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /**
   * Not in the model's tool list (R2b C10): the model finds it with `tool_search` and runs it
   * with `tool_call`, which makes the call as this tool's own.
   */
  readonly deferred?: boolean;
  /** Text the model reads, after the engine's, while this tool is advertised. */
  readonly instructions?: readonly string[];
  /** What runs its calls: their effects' `target` (an MCP tool's identity, our engine's `harness`). */
  readonly target?: EffectTarget;
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
  /**
   * The session's MCP tools as our engine offers them (`mcpToolSet`, from `turn.start.mcp`),
   * after the agent's own and our engine's: every call an effect of the tool's identity. Their
   * layout goes into the state the segment ends with (`mcpLayout`). Not hashed.
   */
  mcp?: McpToolSet;
  /**
   * What our engine adds to each agent of the tree (root and agents used as tools,
   * `engineToolsFor`): its tools, offered after the agent's own and before the session's MCP
   * tools, and the text that goes with them, before the MCP tools' own. Run as host effects; not
   * hashed.
   */
  engineTools?: (agent: AgentManifest) => EngineTools;
  /**
   * Text to keep at the head of the conversation (`ExecutionState.pinned`): the memory index
   * block (`memoryIndexBlock`, track T5). The state keeps what it pinned at the session's first
   * turn, and after a compaction takes this; without it, the state drops its pinned text. Not
   * hashed.
   */
  pinned?: readonly string[];
  /** Segment rollover (Model Calls §10): yield after this many steps or milliseconds. */
  yieldAfter?: { readonly steps?: number; readonly ms?: number };
  /** The model the turn's calls use (`turn.start.model`), for the root and every child. */
  model?: ModelDescriptor;
  /** How the turn's files reach the model (`representFiles`), for the root and every child. */
  files?: FileContext;
  /** The loop's settings (compaction, a failed child's partial output). Default `DEFAULT_LOOP_CONFIG`. */
  loop?: LoopConfig;
}): Promise<DurableResult> {
  // `hostedDefinition` checks the manifest against AgentManifestSchema (`agentFrom`).
  const { manifest, checkpoint, host } = options;
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
    target: Pick<HostEffect, "toolName" | "agent" | "target" | "skill" | "purpose"> = {},
  ): Promise<EffectOutcome> => {
    const effectId = effectIdOf(checkpoint.turnId, checkpoint.segment, kind, identity);
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
  const hostedTools = (agent: AgentManifest, ref?: AgentRef) => {
    let patchTail: Promise<void> = Promise.resolve();
    return (tool: {
      readonly name: string;
      readonly description?: string;
      readonly inputSchema: JsonObject;
      readonly outputSchema?: JsonObject;
      readonly target?: EffectTarget;
    }) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: schemaFromJSON(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: schemaFromJSON(tool.outputSchema) } : {}),
      // No approval here: the Tool Gate holds a call its policy asks a person about (R5 step 2).
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
            identityOf(agent, tool, args, ref),
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
  const sessionTools = options.mcp?.tools ?? [];
  /** Rebuild one agent from its manifest with every tool routed through host effects. */
  const hostedDefinition = (agent: AgentManifest, ref?: AgentRef): AgentDefinition => {
    const hostedTool = hostedTools(agent, ref);
    const engine = options.engineTools?.(agent);
    const mine = [
      ...(engine?.tools ?? []),
      ...sessionTools.filter((tool) => (tool.agentId ?? manifest.id) === agent.id),
    ];
    // Deferred tools stay out of the model's list; `tool_call` runs them (R2b C10).
    const owned = mine.filter((tool) => !tool.deferred);
    const deferred = new Map(mine.filter((tool) => tool.deferred).map((tool) => [tool.name, tool]));
    const tools: Record<string, any> = {};
    // Agents used as tools are rebuilt from their manifest body; the engine runs them. An
    // HTTP tool keeps its target (the manifest's hash covers it) and runs as a host effect.
    // An author's code tool names no target: the record fails it to the model.
    for (const tool of agent.tools ?? [])
      if (tool.http)
        // A pinned `approval` stays for the definition's hash; the Tool Gate holds the call.
        tools[tool.name] = withHttpTarget(
          hostedTool({ ...tool, target: { kind: "http", tool: tool.name } }),
          {
            http: tool.http,
            ...(tool.approval === undefined ? {} : { approval: tool.approval }),
          },
        );
      else if (!tool.agent) tools[tool.name] = hostedTool(tool);
    // Our engine's own tools and the session's run as host effects too.
    for (const tool of owned)
      tools[tool.name] =
        tool.name === TOOL_CALL_TOOL
          ? deferredToolCall(tool, deferred, hostedTool)
          : tool.target?.kind === "runtime" && tool.target.operation === "memory"
            ? checkedMemoryTool(hostedTool(tool))
            : hostedTool(tool);
    const implementations: Implementations = { tools };
    return definitionFor(
      agentFrom(agent, implementations, {
        sessionTools: owned.map((tool) => ({
          name: tool.name,
          ...(tool.instructions?.length ? { instructions: tool.instructions } : {}),
        })),
        ...(engine?.instructions.length ? { sessionInstructions: engine.instructions } : {}),
      }),
    );
  };
  /** The root agent's summary calls, in the order they were made: a compaction edit names them. */
  const summaries: string[] = [];
  const modelCall =
    (ref?: AgentRef): ModelAdapter =>
    async (call, ctx) => {
      const identity = scoped(ref, ctx.invocationId);
      // A compaction of an agent used as a tool lives in our state, not the session's transcript.
      if (ctx.compaction && !ref)
        summaries.push(effectIdOf(checkpoint.turnId, checkpoint.segment, "model", identity));
      return (
        await effect(
          "model",
          call,
          // The call already holds the whole prompt; journaling the request would store it twice.
          { invocationId: ctx.invocationId },
          identity,
          {
            ...(ref ? { agent: ref } : {}),
            ...(ctx.compaction ? { purpose: "summary" as const } : {}),
          },
        )
      ).value as any;
    };
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
          state: withPinned(
            withLayout(
              checkpoint.state ??
                initializeExecutionState(hosted, { executionId: checkpoint.sessionId }),
              options.mcp,
            ),
            options.pinned,
          ),
          input: checkpoint.input,
          info: checkpoint.info,
          signal: options.signal,
          onModelCall: modelCall(),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.files === undefined ? {} : { files: options.files }),
        },
        {
          delegation,
          ...(options.yieldAfter ? { yieldAfter: options.yieldAfter } : {}),
          ...(options.loop ? { loop: options.loop } : {}),
        },
      ),
    );
    return {
      status: result.status,
      checkpoint: { ...checkpoint, state: result.state },
      result,
      ...(summaries.length > 0 ? { summaryEffectIds: [...summaries] } : {}),
    };
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

/** The state with the MCP tools' layout our engine follows (`mcpLayout`), when it has MCP tools. */
function withLayout(state: ExecutionState, mcp: McpToolSet | undefined): ExecutionState {
  if (mcp === undefined) return state;
  const { factsHash, deferred } = mcp.layout;
  return { ...state, mcpLayout: { factsHash, deferred: [...deferred] } };
}

/**
 * The state with the text our engine keeps at the head of the conversation: what it pinned
 * before, or `pinned` when it has none (the session's first turn, or after a compaction).
 */
function withPinned(state: ExecutionState, pinned: readonly string[] | undefined): ExecutionState {
  if (pinned === undefined) {
    if (state.pinned === undefined) return state;
    const { pinned: _dropped, ...rest } = state;
    return rest;
  }
  return state.pinned === undefined ? { ...state, pinned: [...pinned] } : state;
}

/**
 * `memory` (track T5): each command's parameters are checked before the call is sent
 * (`checkMemoryCall`), so a call the Runtime would refuse is never journaled; the model reads the
 * error text and may call again.
 */
function checkedMemoryTool(run: ReturnType<HostedTool>): ReturnType<HostedTool> {
  return {
    ...run,
    async execute(args: unknown, ctx: unknown) {
      const checked = checkMemoryCall(args);
      if ("error" in checked)
        return { kind: "failed", code: "tool.invalid-arguments", message: checked.error };
      return run.execute(args, ctx);
    },
  };
}

/** What a tool effect names beside its input: the tool, what runs it, its skill and its agent. */
function identityOf(
  agent: AgentManifest,
  tool: { readonly name: string; readonly target?: EffectTarget },
  input: unknown,
  ref: AgentRef | undefined,
): Pick<HostEffect, "toolName" | "agent" | "target" | "skill"> {
  const skill = skillOfToolCall(agent, tool, input);
  return {
    toolName: tool.name,
    ...(tool.target === undefined ? {} : { target: tool.target }),
    ...(skill === undefined ? {} : { skill }),
    ...(ref ? { agent: ref } : {}),
  };
}

/** Effect identities of an agent used as a tool live under its delegation. */
function scoped(ref: AgentRef | undefined, identity: string): string {
  return ref ? `${ref.delegationId}/${identity}` : identity;
}

type HostedTool = (tool: DurableSessionTool) => {
  execute(args: unknown, ctx: unknown): Promise<unknown>;
};

/**
 * `tool_call` (R2b C10): runs a deferred tool by name, as that tool's own call. It checks the
 * arguments against the tool's `inputSchema` first, so a mistake comes back to the model as a
 * failed result it can fix. The effect then names the tool and its identity (`target`), so the
 * record routes it and records `tool.completed` as for a direct call, the host shapes its result,
 * and the Tool Gate holds it as it would a direct call.
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
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: schemaFromJSON(tool.inputSchema),
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
        run = hostedTool(target);
        hosted.set(target.name, run);
      }
      return run.execute(checked.value, ctx);
    },
  };
}
