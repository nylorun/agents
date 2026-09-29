import type { JsonValue, WorkflowManifest } from "@nylorun/core/define";
import type { DurableHost, HostEffect } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import { resolveOperatorLimits, type FlowOperatorLimits } from "./limits.js";
import { flowEffectId, iterationsOf, nodeKeyOf } from "./paths.js";
import { failedValueOf, FlowNodeError, type FlowFailure } from "./types.js";

export type FlowEffectKind = "agent" | "tool" | "fn" | "verify";

export type FlowContext = {
  readonly manifest: WorkflowManifest;
  readonly checkpoint: FlowCheckpoint;
  readonly host: DurableHost;
  readonly signal?: AbortSignal;
  /** Operator ceilings (Map items / Loop iterations). */
  readonly limits: FlowOperatorLimits;
  readonly pending: Map<string, "pending" | "uncertain">;
  readonly inFlight: Set<Promise<unknown>>;
  /** Nearest enclosing Chain `results`, outermost first. */
  readonly resultsStack: Array<Record<string, JsonValue>>;
  /** Enclosing Loop iteration numbers, outermost first. */
  iterations: number[];
  /** Effect ids the engine wants cancelled after fail-fast. */
  readonly cancelEffectIds: Set<string>;
  effect(
    kind: FlowEffectKind,
    input: unknown,
    identity: { path: string; key: string; iterations?: string; role?: string },
    context?: Record<string, unknown>,
  ): Promise<unknown>;
  nearestResults(): Record<string, JsonValue>;
  iterationsString(): string;
};

export function createFlowContext(options: {
  readonly manifest: WorkflowManifest;
  readonly checkpoint: FlowCheckpoint;
  readonly host: DurableHost;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<FlowOperatorLimits> | null;
}): FlowContext {
  const pending = new Map<string, "pending" | "uncertain">();
  const inFlight = new Set<Promise<unknown>>();
  const cancelEffectIds = new Set<string>();
  const resultsStack: Array<Record<string, JsonValue>> = [];
  const ctx: FlowContext = {
    manifest: options.manifest,
    checkpoint: options.checkpoint,
    host: options.host,
    signal: options.signal,
    limits: resolveOperatorLimits(options.limits),
    pending,
    inFlight,
    resultsStack,
    iterations: [],
    cancelEffectIds,
    nearestResults() {
      return resultsStack.length === 0 ? {} : resultsStack[resultsStack.length - 1]!;
    },
    iterationsString() {
      return iterationsOf(ctx.iterations);
    },
    async effect(kind, input, identity, context = {}) {
      if (options.signal?.aborted)
        throw new FlowNodeError({ code: "cancelled", message: "cancelled" });
      const iterations = identity.iterations ?? ctx.iterationsString();
      const key = identity.key || nodeKeyOf(identity.path);
      const effectId = flowEffectId({
        turnId: options.checkpoint.turnId,
        segment: options.checkpoint.segment,
        path: identity.path,
        kind,
        iterations,
        ...(identity.role === undefined ? {} : { role: identity.role }),
      });
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
    return { code: "fn.failed", message: error.message, path: fallbackPath };
  return { code: "fn.failed", message: String(error), path: fallbackPath };
}
