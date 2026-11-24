/**
 * The meter. Every model call a gate serves is recorded once in the
 * Tenant's usage ledger (`model_usage`), by the gate itself: the gates service for the stack,
 * the in-process gate otherwise. A failed ledger write is logged and never fails the call.
 *
 * Before the call the meter checks the Tenant's budgets (hard caps). There is no reservation
 *: a cap is reached when the scope's recorded spend, plus this gate's calls in flight in
 * the scope at the scope's average cost per call, reaches its limit. Calls in a turn run one
 * at a time, so a scope overspends by at most one call per concurrent call. The refusal is a
 * `budget_exhausted` failure, which the turn does not retry.
 *
 * The row also keeps the gate's own timing of the call: `now()` before the call and
 * after it, and the adapter's `firstTokenMs` (`evidence.extras`), so a model call's span is
 * what the gate measured; and the adapter's `attempts` and `retries`, so the call's event says
 * how many times the provider was called for it, and why again.
 *
 * Each call it runs is also measured for operators (`recordModelCall`): the meter is the
 * one place every gate's calls pass, in the gates service and in process alike.
 */
import { randomUUID } from "node:crypto";
import { failure } from "../model/classify.js";
import { attemptFacts } from "../model/retry.js";
import type {
  ModelBudgetRow,
  ModelUsageQuery,
  ModelUsageWrite,
  ModelUsageTotals,
  SessionStore,
} from "../store/types.js";
import type { Logger } from "../tenant/types.js";
import type { ModelGateOutcome, ModelGateRequest } from "./model-gate.js";
import { defined, instruments } from "../telemetry/telemetry.js";

export interface Meter {
  /**
   * Runs `call` for `request` unless a budget's cap is reached, then records its usage in
   * `store`. A reached cap answers a `budget_exhausted` failure without calling.
   */
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
  /** Calls running through this gate, per Tenant and budget scope. */
  const inflight = new Map<string, number>();

  async function check(
    store: SessionStore,
    request: ModelGateRequest,
  ): Promise<{ keys: string[]; refusal?: ModelGateOutcome }> {
    const at = now();
    try {
      return await store.tx(async (t) => {
        const keys: string[] = [];
        for (const budget of await t.listModelBudgets()) {
          const query = scopeOf(budget, request, at);
          if (!query) continue;
          const key = `${request.tenantId}|${query.scope}|${query.id ?? "*"}|${query.since ?? ""}`;
          keys.push(key);
          const reached = capReached(budget, await t.modelUsageTotals(query), inflight.get(key) ?? 0);
          if (reached) {
            options.logger.warn("model_budget_exhausted", {
              tenant: request.tenantId,
              session: request.sessionId,
              effect: request.effectId,
              scope: budget.scope,
              ...(budget.scope === "manifest" ? { manifest: budget.scopeId } : {}),
            });
            return { keys, refusal: failure("budget_exhausted", reached, false) };
          }
        }
        return { keys };
      });
    } catch (error) {
      // The caps can't be read: the call goes ahead, as it would without budgets.
      options.logger.warn("model_budget_check_failed", {
        tenant: request.tenantId,
        effect: request.effectId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { keys: [] };
    }
  }

  return {
    async call(store, request, call) {
      const { keys, refusal } = await check(store, request);
      if (refusal) return refusal;
      // A call counts as in flight until its usage is recorded, so the check never misses it.
      for (const key of keys) inflight.set(key, (inflight.get(key) ?? 0) + 1);
      const clock = performance.now();
      try {
        const startedAt = now();
        let outcome: ModelGateOutcome;
        try {
          outcome = await call();
        } catch (error) {
          recordModelCall(request, undefined, (performance.now() - clock) / 1000);
          throw error;
        }
        recordModelCall(request, outcome, (performance.now() - clock) / 1000);
        await record(store, request, outcome, { startedAt, endedAt: now() });
        return outcome;
      } finally {
        for (const key of keys) {
          const left = (inflight.get(key) ?? 1) - 1;
          if (left > 0) inflight.set(key, left);
          else inflight.delete(key);
        }
      }
    },
  };

  async function record(
    store: SessionStore,
    request: ModelGateRequest,
    outcome: ModelGateOutcome,
    timing: CallTiming,
  ) {
    const row = usageRow(request, outcome, timing.endedAt, timing);
    if (!row) return;
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
  }
}

/**
 * A model call's metrics: `gen_ai.client.inference.duration`, the usage counters
 * `gen_ai.client.inference.usage.input_tokens` and `output_tokens`, and
 * `gen_ai.client.inference.time_to_first_chunk` when the adapter measured it, with
 * `gen_ai.operation.name` `chat`, `gen_ai.provider.name`, `gen_ai.request.model` and, for a
 * failure, `error.type` (its code; `aborted` for a call that threw). `outcome` is undefined when
 * the call threw.
 */
export function recordModelCall(request: ModelGateRequest, outcome: ModelGateOutcome | undefined, seconds: number): void {
  const requested = request.call.model?.id;
  const candidate = typeof outcome === "object" && outcome !== null && !("kind" in outcome) ? outcome : undefined;
  const failure = typeof outcome === "object" && outcome !== null && "kind" in outcome ? outcome : undefined;
  const provider = (candidate ? producerOf(candidate).provider : undefined) ?? providerOfModel(requested);
  const attributes = defined({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": requested,
    "error.type": outcome === undefined ? "aborted" : failure ? String(failure.code ?? "failed") : undefined,
  });
  const meters = instruments();
  meters.inferenceDuration.record(seconds, attributes);
  if (!candidate) return;
  const usage = candidate.usage;
  if (usage) {
    meters.inputTokens.add(count(usage.inputTokens), attributes);
    meters.outputTokens.add(count(usage.outputTokens), attributes);
  }
  const firstTokenMs = candidate.evidence?.extras?.firstTokenMs;
  if (typeof firstTokenMs === "number" && Number.isFinite(firstTokenMs) && firstTokenMs >= 0)
    meters.timeToFirstChunk.record(firstTokenMs / 1000, attributes);
}

/** The provider a `provider/model` id names, when it names one. */
function providerOfModel(id: string | undefined): string | undefined {
  const slash = id?.indexOf("/") ?? -1;
  return id !== undefined && slash > 0 ? id.slice(0, slash) : undefined;
}

/** When the gate sent a call and when its answer was complete. */
export interface CallTiming {
  readonly startedAt: Date;
  readonly endedAt: Date;
}

/**
 * The ledger row of an outcome that carries usage; undefined for a failure. With `timing`, the
 * row keeps the gate's start and end of the call, and the adapter's `firstTokenMs`.
 */
export function usageRow(
  request: ModelGateRequest,
  outcome: ModelGateOutcome,
  at: Date,
  timing?: CallTiming,
): ModelUsageWrite | undefined {
  if (typeof outcome !== "object" || "kind" in outcome || !outcome.usage) return undefined;
  const usage = outcome.usage;
  const firstTokenMs = outcome.evidence?.extras?.firstTokenMs;
  const producer = producerOf(outcome);
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  return {
    id: randomUUID(),
    effectKey: request.effectId,
    tokensReported:
      typeof outcome.evidence?.extras?.tokensReported === "boolean"
        ? outcome.evidence.extras.tokensReported
        : null,
    costKnown:
      typeof outcome.evidence?.extras?.costKnown === "boolean"
        ? outcome.evidence.extras.costKnown
        : null,
    sessionId: request.sessionId,
    turnId: request.turnId,
    // The calling agent's loop manifest id: a manifest version's name (protocol 16).
    manifestName: request.agentId,
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
    ...(timing
      ? { startedAt: timing.startedAt.toISOString(), endedAt: timing.endedAt.toISOString() }
      : {}),
    ...(typeof firstTokenMs === "number" && Number.isFinite(firstTokenMs) && firstTokenMs >= 0
      ? { firstTokenMs: Math.round(firstTokenMs) }
      : {}),
    ...costSplitColumns(outcome.evidence?.extras?.costSplit),
    // How many times the gate called the provider for this answer, and why again.
    ...attemptFacts(outcome.evidence?.extras?.attempts, outcome.evidence?.extras?.retries),
  };
}




/** The ledger's cost-by-kind columns from the adapter's `costSplit`; none unless all four are costs. */
function costSplitColumns(split: unknown) {
  if (!split || typeof split !== "object" || Array.isArray(split)) return {};
  const { input, cacheRead, cacheWrite, output } = split as Record<string, unknown>;
  const parts = [input, cacheRead, cacheWrite, output];
  if (!parts.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)) return {};
  return {
    costInputUsd: input as number,
    costCacheReadUsd: cacheRead as number,
    costCacheWriteUsd: cacheWrite as number,
    costOutputUsd: output as number,
  };
}

/** The ledger rows a budget counts for `request`; undefined when it doesn't apply. */
function scopeOf(budget: ModelBudgetRow, request: ModelGateRequest, at: Date): ModelUsageQuery | undefined {
  const since = budget.period ? { since: periodStart(budget.period, at) } : {};
  if (budget.scope === "turn") return { scope: "turn", id: request.turnId };
  if (budget.scope === "manifest")
    return budget.scopeId === request.agentId ? { scope: "manifest", id: request.agentId, ...since } : undefined;
  return { scope: "tenant", ...since };
}

/**
 * Why the budget refuses another call, or undefined. Calls in flight count at the scope's
 * average cost per recorded call.
 */
export function capReached(
  budget: Pick<ModelBudgetRow, "scope" | "scopeId" | "period" | "limitUsd" | "limitTokens">,
  spent: ModelUsageTotals,
  inflight: number,
): string | undefined {
  const projected = (total: number) => total + (spent.calls > 0 ? (inflight * total) / spent.calls : 0);
  const name =
    budget.scope === "turn"
      ? "The turn's cap"
      : `${budget.scope === "manifest" ? `Agent manifest ${budget.scopeId}'s` : "The Tenant's"} ${budget.period === "day" ? "daily" : "monthly"} cap`;
  const raise = "raise it with PUT /v1/tenant/budgets";
  if (budget.limitTokens !== null && projected(spent.tokens) >= budget.limitTokens)
    return `${name} of ${budget.limitTokens} tokens is reached (${spent.tokens} used); ${raise}`;
  if (budget.limitUsd !== null && projected(spent.costUsd) >= budget.limitUsd)
    return `${name} of $${budget.limitUsd} is reached ($${spent.costUsd.toFixed(4)} spent); ${raise}`;
  return undefined;
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
