/**
 * The engine's `DurableHost` over the Harness API. An effect whose outcome came with the run
 * (same id, same request hash) resolves here; any other becomes an `effect.intent`. A model
 * intent carries no prompt: core stores its hash. When core answers `execute`, the harness runs
 * the call and reports its outcome: a `harness` tool (ours) here, over the Harness API's seams,
 * and anything else through the executors.
 *
 * A tool call whose gate hop lost its answer (`executors.resends`) is sent again with the same
 * key (R5.3): the harness waits a moment and asks core again with the same intent, and core
 * counts the send, answering `execute` again or the call's outcome once it reached its cap.
 */
import {
  HarnessApiError,
  effectRequestHash,
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
import { isSkillTool, runSkillTool } from "../tools/skills.js";
import type { EngineToolOptions } from "../tools/engine-tools.js";
import { runAbortKind } from "./abort.js";
import type { HarnessExecutors, HarnessRun } from "./executors.js";

/** What our engine's own tools run with: the harness's configuration of them. */
export type EngineToolConfig = EngineToolOptions;

/**
 * The host of one run. A `harness` tool call is one of our engine's own tools, run here: the skill
 * tools over `definition.file`, the artifact tools over the artifact seam and `executors.files`.
 * Every other tool call goes to `executors.tool`, which routes it by its target.
 */
export function apiHost(
  channel: HarnessChannel,
  executors: HarnessExecutors,
  run: HarnessRun,
  engine: EngineToolConfig,
): DurableHost {
  const recorded = new Map<string, RecordedOutcome>(
    run.start.outcomes.map((outcome) => [outcome.effectId, outcome]),
  );
  const { signal, runId } = run;
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
            : await executors.tool(effect, signal, run, traceparent ? { traceparent } : {});
        return await ask("effect.outcome", { runId, effectId: effect.effectId, value });
      } catch (error) {
        // Another owner decides what the effect became.
        if (error instanceof HarnessApiError && error.code === "ownership_lost") throw error;
        const recoverable = model ? executors.recovers.model : executors.recovers.tool(effect, run);
        const kind = runAbortKind(signal);
        // The call goes on at its gate: the next run re-sends it and collects its outcome.
        if (recoverable && kind === "shutdown") throw error;
        // The hop lost the answer: core counts one more send, and the call goes again (R5.3).
        if (!model && kind === undefined && executors.resends?.(effect, error, run)) {
          await pause(RESEND_DELAYS_MS[Math.min(resent, RESEND_DELAYS_MS.length - 1)]!, signal);
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

  /** Runs a call of one of our engine's own tools. */
  const engineTool = (effect: HostEffect): Promise<unknown> => {
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
        return { status: "completed", outcome: known.outcome };
      }
      const answer = await ask("effect.intent", { runId, effect: intentOf(effect), requestHash });
      if (answer.status === "execute") return execute(effect, requestHash, answer.traceparent);
      return answer;
    },
  };
}

/** How long the harness waits before it sends a call whose gate hop was lost again. */
const RESEND_DELAYS_MS = [1_000, 2_000, 4_000] as const;

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
