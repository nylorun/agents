/**
 * The engine's `DurableHost` over the Harness API. An effect whose outcome came with the run
 * (same id, same request hash) resolves here; any other becomes an `effect.intent`. A model
 * intent carries no prompt: core stores its hash. When core answers `execute`, the harness runs
 * the call and reports its outcome. When it answers `pending` for an Action (a tool, hook, `fn`
 * or `verify` an Action endpoint runs), the run may hold for its outcome (`options.hold`).
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
import type { ActionOutcome } from "@nylorun/core/contracts";
import type { DurableHost, EffectResolution, HostEffect } from "../run/durable.js";
import { runAbortKind } from "./abort.js";
import type { HarnessExecutors, HarnessRun } from "./executors.js";

export interface ApiHostOptions {
  /** Waits for core's outcome of a pending Action; undefined when none came in time. */
  readonly hold?: (effectId: string) => Promise<ActionOutcome | undefined>;
}

/** Effects whose `pending` is an Action endpoint's work, which a run may hold for. */
const HELD_KINDS: ReadonlySet<HostEffect["kind"]> = new Set(["tool", "hook", "fn", "verify"]);

export function apiHost(
  channel: HarnessChannel,
  executors: HarnessExecutors,
  run: HarnessRun,
  options: ApiHostOptions = {},
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

  const execute = async (effect: HostEffect): Promise<EffectResolution> => {
    const model = effect.kind === "model";
    try {
      const value = model
        ? await executors.model(effect, signal, run)
        : await executors.tool(effect, signal, run);
      return await ask("effect.outcome", { runId, effectId: effect.effectId, value });
    } catch (error) {
      // Another owner decides what the effect became.
      if (error instanceof HarnessApiError && error.code === "ownership_lost") throw error;
      const recoverable = model
        ? executors.recovers.model
        : executors.recovers.remoteMcp(effect, run);
      const kind = runAbortKind(signal);
      // The call goes on at its gate: the next run re-sends it and collects its outcome.
      if (recoverable && kind === "shutdown") throw error;
      if (recoverable && !model && kind === "cancel") await executors.cancelAtGate?.(effect, run);
      return ask("effect.outcome", {
        runId,
        effectId: effect.effectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      if (answer.status === "execute") return execute(effect);
      if (answer.status === "pending" && options.hold && HELD_KINDS.has(effect.kind)) {
        const outcome = await options.hold(effect.effectId);
        if (signal.aborted) throw signal.reason;
        if (outcome) return { status: "completed", outcome };
      }
      return answer;
    },
  };
}

/** What crosses for an effect: a model call's prompt stays here. */
function intentOf(effect: HostEffect): EffectIntent {
  if (effect.kind !== "model") return effect;
  const { input: _, ...intent } = effect;
  return intent;
}
