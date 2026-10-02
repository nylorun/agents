/**
 * The meter (blueprint §15, P1.3). Every model call a gate serves is recorded once in the
 * Tenant's usage ledger (`model_usage`), by the gate itself: the gates service for the stack,
 * the in-process gate otherwise. A failed ledger write is logged and never fails the call.
 */
import { randomUUID } from "node:crypto";
import type { ModelUsageRow, SessionStore } from "../store/types.js";
import type { Logger } from "../tenant/types.js";
import type { ModelGateOutcome, ModelGateRequest } from "./model-gate.js";

export interface Meter {
  /** Runs `call` for `request`, then records its usage in `store`. */
  call(
    store: SessionStore,
    request: ModelGateRequest,
    call: () => Promise<ModelGateOutcome>,
  ): Promise<ModelGateOutcome>;
}

export interface MeterOptions {
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function createMeter(options: MeterOptions): Meter {
  const now = options.now ?? (() => new Date());
  return {
    async call(store, request, call) {
      const outcome = await call();
      const row = usageRow(request, outcome, now());
      if (row)
        try {
          const recorded = await store.tx((t) => t.recordModelUsage(row));
          if (recorded.duplicate)
            options.logger.warn("model_usage_duplicate", {
              tenant: request.tenantId,
              effect: request.effectId,
            });
        } catch (error) {
          options.logger.warn("model_usage_failed", {
            tenant: request.tenantId,
            effect: request.effectId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      return outcome;
    },
  };
}

/** The ledger row of an outcome that carries usage; undefined for a failure. */
export function usageRow(
  request: ModelGateRequest,
  outcome: ModelGateOutcome,
  at: Date,
): Omit<ModelUsageRow, "duplicate"> | undefined {
  if (typeof outcome !== "object" || "kind" in outcome || !outcome.usage) return undefined;
  const usage = outcome.usage;
  const producer = producerOf(outcome);
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  return {
    id: randomUUID(),
    effectKey: request.effectId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    agentId: request.agentId,
    provider: producer.provider ?? null,
    model: producer.model ?? outcome.evidence?.resolvedModel ?? request.call.model?.id ?? null,
    inputTokens,
    outputTokens,
    totalTokens: count(usage.totalTokens) || inputTokens + outputTokens,
    cachedTokens: count(usage.cachedTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    reasoningTokens: count(usage.reasoningTokens),
    costUsd: Number.isFinite(usage.costUsd) && usage.costUsd! > 0 ? usage.costUsd! : 0,
    createdAt: at.toISOString(),
  };
}

/** When the UTC `period` containing `now` started, as an ISO time. */
export function periodStart(period: "day" | "month", now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), period === "day" ? now.getUTCDate() : 1),
  ).toISOString();
}

const count = (value: number | undefined) =>
  Number.isFinite(value) && value! > 0 ? Math.round(value!) : 0;

/** The provider and model `piModel` records as the candidate's producer. */
function producerOf(candidate: {
  readonly evidence?: { readonly extras?: Readonly<Record<string, unknown>> };
}): { provider?: string; model?: string } {
  const producer = candidate.evidence?.extras?.producer;
  if (typeof producer !== "object" || producer === null || Array.isArray(producer)) return {};
  const { provider, model } = producer as Record<string, unknown>;
  return {
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof model === "string" ? { model } : {}),
  };
}
