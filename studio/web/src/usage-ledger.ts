/**
 * The Usage tab's ledger: the session, its turns and each turn's model calls, with the same
 * measures at every level (cached input, uncached input, cache write, output, total, time, cost),
 * so each row adds up to the one above it. Facts only: no ratio says whether a number is good.
 */

/** A token kind, in the order the tab shows it. `input` is the uncached input. */
export type TokenKind = "cacheRead" | "input" | "cacheWrite" | "output";

export const TOKEN_KINDS: readonly { kind: TokenKind; label: string }[] = [
  { kind: "cacheRead", label: "Cached input" },
  { kind: "input", label: "Uncached input" },
  { kind: "cacheWrite", label: "Cache write" },
  { kind: "output", label: "Output" },
];

type CostSplit = Readonly<{ input: number; cacheRead: number; cacheWrite: number; output: number }>;

type Usage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}>;

export type LedgerCall = Readonly<{
  id: string;
  effectId: string;
  turnId: string;
  at: string;
  startedAt: string | null;
  endedAt: string | null;
  usage: (Usage & Readonly<{ costSplit: CostSplit | null }>) | null;
}>;

export type LedgerTotals = Usage &
  Readonly<{
    calls: number;
    costSplit: CostSplit;
    splitCalls: number;
    modelTimeMs: number;
    timedCalls: number;
  }>;

/** Tokens by kind. */
export type Tokens = Readonly<Record<TokenKind, number>>;

function tokensOf(usage: Usage): Tokens {
  return {
    cacheRead: usage.cachedTokens,
    input: usage.inputTokens,
    cacheWrite: usage.cacheWriteTokens,
    output: usage.outputTokens,
  };
}

function sumTokens(tokens: Tokens): number {
  return tokens.cacheRead + tokens.input + tokens.cacheWrite + tokens.output;
}

export type LedgerPart = Readonly<{
  kind: TokenKind;
  label: string;
  tokens: number;
  tokenShare: number;
  /** null when no call kept its cost by kind. */
  cost: number | null;
  costShare: number | null;
}>;

export type SessionLedger = Readonly<{
  parts: readonly LedgerPart[];
  totalTokens: number;
  totalCost: number;
  /** Cost of calls recorded before the split was kept; 0 when every call kept it. */
  unsplitCost: number;
  reasoningTokens: number;
}>;

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/**
 * The session's ledger rows. Cache write shows only when the session wrote to the cache. The
 * total is the sum of the rows, so the rows always add up to it.
 */
export function sessionLedger(totals: LedgerTotals): SessionLedger {
  const tokens = tokensOf(totals);
  const totalTokens = sumTokens(tokens);
  const split = totals.splitCalls > 0 ? totals.costSplit : null;
  const splitSum = split ? split.input + split.cacheRead + split.cacheWrite + split.output : 0;
  const unsplit = totals.costUsd - splitSum;
  const parts = TOKEN_KINDS.filter(
    ({ kind }) => kind !== "cacheWrite" || tokens.cacheWrite > 0 || (split?.cacheWrite ?? 0) > 0,
  ).map(({ kind, label }) => {
    const cost = split ? split[kind] : null;
    return {
      kind,
      label,
      tokens: tokens[kind],
      tokenShare: share(tokens[kind], totalTokens),
      cost,
      costShare: cost === null ? null : share(cost, totals.costUsd),
    };
  });
  return {
    parts,
    totalTokens,
    totalCost: totals.costUsd,
    // Below a billionth of a dollar the difference is rounding, not a call.
    unsplitCost: split === null ? 0 : unsplit > 1e-9 ? unsplit : 0,
    reasoningTokens: totals.reasoningTokens,
  };
}

/** A call's duration from the gate's timing; null when it was not timed. */
export function durationOf(call: Pick<LedgerCall, "startedAt" | "endedAt">): number | null {
  if (call.startedAt === null || call.endedAt === null) return null;
  const ms = Date.parse(call.endedAt) - Date.parse(call.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export type LedgerRow = Readonly<{
  tokens: Tokens;
  total: number;
  /** null when no call in the row was timed. */
  durationMs: number | null;
  cost: number;
}>;

export type CallRow<C extends LedgerCall = LedgerCall> = LedgerRow &
  Readonly<{ call: C; number: number; start: string; recorded: boolean }>;

export type TurnRow<C extends LedgerCall = LedgerCall> = LedgerRow &
  Readonly<{ turnId: string; number: number; start: string; calls: readonly CallRow<C>[] }>;

const NO_TOKENS: Tokens = { cacheRead: 0, input: 0, cacheWrite: 0, output: 0 };

/**
 * The calls grouped by turn, in the order the calls came (the ledger's order): turns and calls
 * are numbered from 1 in that order.
 */
export function turnsOf<C extends LedgerCall>(calls: readonly C[]): TurnRow<C>[] {
  const turns = new Map<string, CallRow<C>[]>();
  calls.forEach((call, index) => {
    const tokens = call.usage ? tokensOf(call.usage) : NO_TOKENS;
    const row: CallRow<C> = {
      call,
      number: index + 1,
      start: call.startedAt ?? call.at,
      recorded: call.usage !== null,
      tokens,
      total: sumTokens(tokens),
      durationMs: durationOf(call),
      cost: call.usage?.costUsd ?? 0,
    };
    const rows = turns.get(call.turnId);
    if (rows) rows.push(row);
    else turns.set(call.turnId, [row]);
  });
  return [...turns].map(([turnId, rows], index) => {
    const tokens = rows.reduce<Tokens>(
      (sum, row) => ({
        cacheRead: sum.cacheRead + row.tokens.cacheRead,
        input: sum.input + row.tokens.input,
        cacheWrite: sum.cacheWrite + row.tokens.cacheWrite,
        output: sum.output + row.tokens.output,
      }),
      NO_TOKENS,
    );
    const timed = rows.filter((row) => row.durationMs !== null);
    return {
      turnId,
      number: index + 1,
      start: rows[0]!.start,
      calls: rows,
      tokens,
      total: sumTokens(tokens),
      durationMs: timed.length ? timed.reduce((sum, row) => sum + row.durationMs!, 0) : null,
      cost: rows.reduce((sum, row) => sum + row.cost, 0),
    };
  });
}

/** A duration at a glance: `0.4s`, `12.3s`, `1m 38s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * One precision for every cost in a ledger, so its columns line up: a hundredth of a cent while the
 * session cost under a dollar, else cents.
 */
export function ledgerCost(sessionUsd: number): (usd: number) => string {
  const digits = sessionUsd < 1 ? 4 : 2;
  return (usd) => `$${usd.toFixed(digits)}`;
}

/** A share as a whole percentage. */
export function formatShare(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** The event types that carry a model call's effect id, the call's own first. */
const CALL_EVENT_TYPES = ["message.assistant", "model.failed", "context.compacted"];

/**
 * The event that records each model call, by the call's effect id: its `message.assistant`, or
 * else its `model.failed` or `context.compacted`.
 */
export function callEvents<E extends Readonly<{ type: string; payload?: unknown }>>(
  events: readonly E[],
): Map<string, E> {
  const found = new Map<string, E>();
  for (const type of CALL_EVENT_TYPES)
    for (const event of events) {
      if (event.type !== type) continue;
      const payload = event.payload;
      const effectId =
        payload !== null && typeof payload === "object"
          ? (payload as { effectId?: unknown }).effectId
          : undefined;
      if (typeof effectId === "string" && !found.has(effectId)) found.set(effectId, event);
    }
  return found;
}
