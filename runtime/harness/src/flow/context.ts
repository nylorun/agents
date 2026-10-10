import type { WorkflowManifest } from "@nylorun/core/define";
import type { DurableHost, HostEffect } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import { resolveOperatorLimits, type FlowOperatorLimits } from "./limits.js";
import { flowEffectId, nodeKeyOf } from "./paths.js";
import {
  failedValueOf,
  FlowNodeError,
  FlowPause,
  type FlowDurableResult,
  type FlowFailure,
  type FlowInteraction,
} from "./types.js";

export type FlowEffectKind = "agent" | "tool";

export type FlowContext = {
  readonly manifest: WorkflowManifest;
  readonly checkpoint: FlowCheckpoint;
  readonly host: DurableHost;
  readonly signal?: AbortSignal;
  /** Operator ceilings (Map items / Loop iterations). */
  readonly limits: FlowOperatorLimits;
  readonly pending: Map<string, "pending" | "uncertain">;
  /** Interactions tool nodes wait on, by interaction id. */
  readonly interactions: Map<string, FlowInteraction>;
  readonly inFlight: Set<Promise<unknown>>;
  /** Effect ids the engine wants cancelled after fail-fast. */
  readonly cancelEffectIds: Set<string>;
  effect(
    kind: FlowEffectKind,
    input: unknown,
    identity: { path: string; key: string; iterations: string; role?: string },
    context?: Record<string, unknown>,
  ): Promise<unknown>;
  /** The id `effect` gives an effect of `kind` at `identity`. */
  effectIdOf(
    kind: FlowEffectKind,
    identity: { path: string; iterations: string; role?: string },
  ): string;
  /** Records an interaction a tool node waits on; throw what it returns. */
  pause(interaction: FlowInteraction): FlowPause;
};

export function createFlowContext(options: {
  readonly manifest: WorkflowManifest;
  readonly checkpoint: FlowCheckpoint;
  readonly host: DurableHost;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<FlowOperatorLimits> | null;
}): FlowContext {
  const pending = new Map<string, "pending" | "uncertain">();
  const interactions = new Map<string, FlowInteraction>();
  const inFlight = new Set<Promise<unknown>>();
  const cancelEffectIds = new Set<string>();
  const ctx: FlowContext = {
    manifest: options.manifest,
    checkpoint: options.checkpoint,
    host: options.host,
    signal: options.signal,
    limits: resolveOperatorLimits(options.limits),
    pending,
    interactions,
    inFlight,
    cancelEffectIds,
    effectIdOf(kind, identity) {
      return flowEffectId({
        turnId: options.checkpoint.turnId,
        segment: options.checkpoint.segment,
        path: identity.path,
        kind,
        iterations: identity.iterations,
        ...(identity.role === undefined ? {} : { role: identity.role }),
      });
    },
    pause(interaction) {
      interactions.set(interaction.interaction.id, interaction);
      return new FlowPause(interaction);
    },
    async effect(kind, input, identity, context = {}) {
      if (options.signal?.aborted)
        throw new FlowNodeError({ code: "cancelled", message: "cancelled" });
      const { iterations } = identity;
      const key = identity.key || nodeKeyOf(identity.path);
      const effectId = ctx.effectIdOf(kind, identity);
      if (cancelEffectIds.has(effectId))
        throw new FlowNodeError({
          code: "cancelled",
          message: "Effect cancelled by fail-fast",
          path: identity.path,
        });
      const request: HostEffect = JSON.parse(
        JSON.stringify({
          effectId,
          sessionId: options.checkpoint.sessionId,
          turnId: options.checkpoint.turnId,
          agentId: options.manifest.id,
          manifestHash: options.checkpoint.manifestHash,
          kind,
          path: identity.path,
          key,
          iterations,
          input,
          context,
        }),
      );
      const operation = options.host.resolveEffect(request);
      inFlight.add(operation);
      let result: Awaited<ReturnType<DurableHost["resolveEffect"]>>;
      try {
        result = await operation;
      } finally {
        inFlight.delete(operation);
      }
      if (result.status !== "completed") {
        pending.set(effectId, result.status);
        throw new HostSuspension(effectId, result.status);
      }
      const failure = failedValueOf(result.outcome.value);
      if (failure) {
        throw new FlowNodeError({
          ...failure,
          path: failure.path ?? identity.path,
        });
      }
      return result.outcome.value;
    },
  };
  return ctx;
}

/**
 * The result of a flow that unwound on a suspension: waiting (or uncertain) while any effect is
 * pending, otherwise paused on the interactions its tool nodes wait on.
 */
export function suspendedResult(ctx: FlowContext): FlowDurableResult {
  const { checkpoint } = ctx;
  if (ctx.pending.size === 0 && ctx.interactions.size > 0) {
    const pending = [...ctx.interactions.values()];
    return { status: "paused", checkpoint, result: { status: "paused", pending } };
  }
  return {
    status: [...ctx.pending.values()].includes("uncertain") ? "uncertain" : "waiting",
    checkpoint,
    effectIds: [...ctx.pending.keys()],
  };
}

export function markFailFastCancels(ctx: FlowContext): void {
  for (const effectId of ctx.pending.keys()) ctx.cancelEffectIds.add(effectId);
}

export async function settleInFlight(ctx: FlowContext): Promise<void> {
  await Promise.allSettled([...ctx.inFlight]);
}

export function failureOf(error: unknown, fallbackPath?: string): FlowFailure {
  if (error instanceof FlowNodeError) {
    return {
      ...error.failure,
      path: error.failure.path ?? fallbackPath,
    };
  }
  if (error instanceof Error && error.message)
    return { code: "flow.failed", message: error.message, path: fallbackPath };
  return { code: "flow.failed", message: String(error), path: fallbackPath };
}
