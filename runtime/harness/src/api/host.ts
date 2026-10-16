/**
 * The engine's `DurableHost` over the Harness API. An effect whose outcome came with the run
 * (same id, same request hash) resolves here; any other becomes an `effect.intent`. A model
 * intent carries no prompt: core stores its hash. When core answers `execute`, the harness runs
 * the call and reports its outcome: a `harness` tool (ours) here, over the Harness API's seams,
 * and anything else through the executors. Before a `sandbox` call our engine mounts the skill
 * folders of the turn's tree (`mountSkills`); the host only writes them.
 *
 * Every tool outcome is shaped before it is reported (`shapeToolOutcome`, protocol 15): the
 * record refuses an entry past `limits.recordEntryBytes`, so a large or binary MCP or HTTP result,
 * or a sandbox result past what its step has left, is stored with `artifact.write` (keyed by the
 * effect) and the outcome carries a preview. One step's results share a budget (`StepBudget`),
 * which replayed outcomes count toward. A cancel skips the shaping: its outcome is discarded.
 *
 * A tool call whose gate hop lost its answer (`executors.resends`) is sent again with the same
 * key (R5.3): the harness waits a moment and asks core again with the same intent, and core
 * counts the send, answering `execute` again or the call's outcome once it reached its cap.
 */
import {
  HarnessApiError,
  effectRequestHash,
  writeArtifactBytes,
  type EffectIntent,
  type HarnessChannel,
  type HarnessMethod,
  type ParamsOf,
  type RecordedOutcome,
  type ResultOf,
} from "@nylorun/core/harness-api";
import type { DurableHost, EffectResolution, HostEffect } from "../run/durable.js";
import { delegatesOf, type AgentManifest } from "@nylorun/core/define";
import { isArtifactTool, runArtifactTool } from "../tools/artifacts.js";
import { isSkillTool, mountSkills, runSkillTool } from "../tools/skills.js";
import type { EngineToolOptions } from "../tools/engine-tools.js";
import type { McpToolSet } from "../tools/mcp.js";
import {
  StepBudget,
  jsonBytes,
  mayNeedShaping,
  shapeToolOutcome,
  spillKey,
  type Stored,
} from "../tools/results.js";
import { isToolSearch, runToolSearch } from "../tools/tool-search.js";
import { runAbortKind } from "./abort.js";
import type { HarnessExecutors, HarnessRun } from "./executors.js";
import type { LoopConfig } from "../loop/config.js";

/**
 * Our engine's configuration in a harness (`createHarness`): its own tools, its loop, and how it
 * sends again a tool call whose gate hop lost its answer.
 */
export interface EngineConfig extends EngineToolOptions {
  readonly loop: LoopConfig;
  /** The waits before each resend; the last repeats for every resend after. */
  readonly resendDelaysMs: readonly number[];
}

/**
 * The host of one run. A `harness` tool call is one of our engine's own tools, run here: the skill
 * tools over `definition.file`, the artifact tools over the artifact seam and `executors.files`,
 * `tool_search` over the run's MCP tools (`mcp`). Every other tool call goes to `executors.tool`,
 * which routes it by its target.
 */
export function apiHost(
  channel: HarnessChannel,
  executors: HarnessExecutors,
  run: HarnessRun,
  engine: EngineConfig,
  mcp?: McpToolSet,
): DurableHost {
  const recorded = new Map<string, RecordedOutcome>(
    run.start.outcomes.map((outcome) => [outcome.effectId, outcome]),
  );
  const { signal, runId } = run;
  const { limits } = run.start;
  const budget = new StepBudget(engine.toolResults, limits);
  const ask = async <M extends HarnessMethod>(
    method: M,
    params: ParamsOf<M>,
  ): Promise<ResultOf<M>> => {
    try {
      return await channel.request(method, params);
    } catch (error) {
      // Core stopped the run: the engine sees the abort, as it would its own.
      if (signal.aborted) throw signal.reason;
      throw error;
    }
  };

  const execute = async (
    effect: HostEffect,
    requestHash: string,
    traceparent: string | undefined,
  ): Promise<EffectResolution> => {
    const model = effect.kind === "model";
    for (let resent = 0; ; resent += 1) {
      try {
        const value = model
          ? await executors.model(effect, signal, run)
          : effect.target?.kind === "harness"
            ? await engineTool(effect)
            : ((await mounted(effect)) ??
              (await executors.tool(effect, signal, run, traceparent ? { traceparent } : {})));
        const outcome = model ? value : await shape(effect, value);
        const answer = await ask("effect.outcome", {
          runId,
          effectId: effect.effectId,
          value: outcome,
        });
        if (answer.status === "completed") budget.count(effect, answer.outcome.value);
        return answer;
      } catch (error) {
        // Another owner decides what the effect became.
        if (error instanceof HarnessApiError && error.code === "ownership_lost") throw error;
        const recoverable = model ? executors.recovers.model : executors.recovers.tool(effect, run);
        const kind = runAbortKind(signal);
        // The call goes on at its gate: the next run re-sends it and collects its outcome.
        if (recoverable && kind === "shutdown") throw error;
        // The hop lost the answer: core counts one more send, and the call goes again (R5.3).
        if (!model && kind === undefined && executors.resends?.(effect, error, run)) {
          const delays = engine.resendDelaysMs;
          await pause(delays[Math.min(resent, delays.length - 1)]!, signal);
          const again = await ask("effect.intent", {
            runId,
            effect: intentOf(effect),
            requestHash,
          });
          if (again.status === "execute") {
            traceparent = again.traceparent ?? traceparent;
            continue;
          }
          return again;
        }
        if (recoverable && !model && kind === "cancel") await executors.cancelAtGate?.(effect, run);
        return ask("effect.outcome", {
          runId,
          effectId: effect.effectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /**
   * A tool call's outcome as it is recorded: shaped to fit what its step has left (an MCP or
   * HTTP tool also to the inline cap), its stored parts written as artifacts of the call. Our
   * engine's own tools are sized by their own configuration and go as they are; after a cancel
   * nothing is stored, since the outcome is discarded.
   */
  const shape = (effect: HostEffect, value: unknown): Promise<unknown> => {
    const kind = effect.target?.kind;
    if (effect.kind !== "tool" || kind === "harness" || effect.toolName === undefined)
      return Promise.resolve(value);
    if (runAbortKind(signal) === "cancel" || !mayNeedShaping(value, engine.toolResults)) {
      budget.count(effect, value);
      return Promise.resolve(value);
    }
    return budget.serialize(effect, async () => {
      const result = await shapeToolOutcome(value, {
        effect,
        limit: budget.reserve(effect, kind === "mcp" || kind === "http"),
        ...(run.start.model ? { model: run.start.model } : {}),
        limits,
        config: engine.toolResults,
        store: (bytes, artifact) => store(effect, bytes, artifact),
      });
      // Shaping keeps a result under its cap; one that a store could not hold is refused here,
      // never by the record.
      const fitted = jsonBytes(result) > budget.budget ? tooLarge(result) : result;
      budget.count(effect, fitted);
      return fitted;
    });
  };

  /** Stores a tool result's bytes as an artifact of the run's session, linked to its call. */
  const store = async (
    effect: HostEffect,
    bytes: Uint8Array,
    artifact: { readonly name: string; readonly contentType: string; readonly index?: number },
  ): Promise<Stored> => {
    try {
      const { artifact: written } = await writeArtifactBytes(
        channel,
        {
          runId,
          key: spillKey(effect.effectId, artifact.index ?? "whole", bytes),
          name: artifact.name,
          contentType: artifact.contentType,
          effectId: effect.effectId,
          chunkBytes: limits.chunkBytes,
          signal,
        },
        bytes,
      );
      return {
        artifactId: written.artifactId,
        version: written.version,
        contentType: written.contentType,
        size: written.size,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      // A limit is the Tenant's to raise: the preview stays, and the model learns why the rest
      // is gone. A run core no longer lets this harness hold is not ours to go on with.
      if (!(error instanceof HarnessApiError) || LOST.has(error.code)) throw error;
      return {
        dropped: `The result could not be stored as an artifact: ${error.message}`,
        size: bytes.byteLength,
      };
    }
  };

  /**
   * Before a `sandbox` call, the skill folders of the turn's tree, which our engine decides about
   * (protocol 15): a failed outcome, the call's own, when one cannot be put in the sandbox.
   */
  const mounted = async (effect: HostEffect) =>
    effect.target?.kind === "sandbox" && executors.files
      ? mountSkills(executors.files, channel, run, signal)
      : undefined;

  /** Runs a call of one of our engine's own tools. */
  const engineTool = (effect: HostEffect): Promise<unknown> => {
    if (isToolSearch(effect))
      return Promise.resolve(
        runToolSearch(effect, mcp?.deferredOf(effect.agent?.id) ?? [], engine.mcpTools),
      );
    if (isArtifactTool(effect.toolName))
      return runArtifactTool(effect, {
        channel,
        run,
        ...(executors.files ? { files: executors.files } : {}),
        pageBytes: engine.artifactPageBytes,
        signal,
      });
    if (isSkillTool(effect.toolName))
      return runSkillTool(effect, {
        channel,
        run,
        agent: agentOf(run.start.manifest as AgentManifest, effect),
        readBytes: engine.skillReadBytes,
        sandboxed: run.start.environment?.sandbox !== undefined,
        signal,
      });
    return Promise.resolve({
      kind: "failed",
      code: "tool.unknown",
      message: `This harness runs no tool named '${effect.toolName ?? ""}'.`,
    });
  };

  return {
    async resolveEffect(effect) {
      if (signal.aborted) throw signal.reason;
      const requestHash = effectRequestHash(effect);
      const known = recorded.get(effect.effectId);
      if (known) {
        if (known.requestHash !== requestHash)
          throw new HarnessApiError("effect_drift", "Effect identity request drift");
        // A replayed result took its share of its step's budget.
        budget.count(effect, known.outcome.value);
        return { status: "completed", outcome: known.outcome };
      }
      const answer = await ask("effect.intent", { runId, effect: intentOf(effect), requestHash });
      if (answer.status === "execute") return execute(effect, requestHash, answer.traceparent);
      if (answer.status === "completed") budget.count(effect, answer.outcome.value);
      return answer;
    },
  };
}

/** A tool result our engine could not make fit its step: the model sees why. */
function tooLarge(value: unknown) {
  return {
    kind: "failed",
    code: "tool.result-too-large",
    message: `The tool's result is ${jsonBytes(value)} bytes as shaped, more than one step's results may hold, and it could not be stored as an artifact.`,
  };
}

/** Answers that say the run is no longer this harness's to go on with. */
const LOST: ReadonlySet<string> = new Set(["ownership_lost", "run_not_held", "turn_cancelled"]);

/** Waits `ms`, or throws the reason as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The agent of the turn's manifest an effect is for: the root, or an agent it uses as a tool. */
function agentOf(manifest: AgentManifest, effect: HostEffect): Pick<AgentManifest, "skills"> {
  if (effect.agent === undefined) return manifest;
  return (
    delegatesOf(manifest).find((delegate) => delegate.manifest.id === effect.agent!.id)?.manifest ??
    {}
  );
}

/** What crosses for an effect: a model call's prompt stays here. */
function intentOf(effect: HostEffect): EffectIntent {
  if (effect.kind !== "model") return effect;
  const { input: _, ...intent } = effect;
  return intent;
}
