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

/**
 * The context a call sent: its input as the provider measured it, uncached, read from the cache
 * and written to it. The output is not part of it.
 */
export function contextOf(tokens: Tokens): number {
  return tokens.cacheRead + tokens.input + tokens.cacheWrite;
}

type EventLike = Readonly<{ type: string; payload?: unknown }>;

function payloadOf(event: EventLike): Readonly<Record<string, unknown>> {
  const payload = event.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

/** The agent a call's event names (`agent.path`, `agent.delegationId`); none for the root. */
function agentOf(event: EventLike | undefined): { path: string; delegationId?: string } | undefined {
  if (!event) return undefined;
  const agent = payloadOf(event).agent;
  if (agent === null || typeof agent !== "object") return undefined;
  const { path, delegationId } = agent as { path?: unknown; delegationId?: unknown };
  if (typeof path !== "string" || path === "") return undefined;
  return typeof delegationId === "string" ? { path, delegationId } : { path };
}

/**
 * What the session's events say about each call, by its effect id: the subagent that made it
 * (absent for the root agent) and whether it wrote a compaction summary (`context.compacted`).
 */
export type CallFacts = Readonly<{
  agentPath?: string;
  delegationId?: string;
  summary: boolean;
  trigger?: string;
}>;

export function callFacts<E extends EventLike>(byCall: ReadonlyMap<string, E>): Map<string, CallFacts> {
  const facts = new Map<string, CallFacts>();
  for (const [effectId, event] of byCall) {
    const agent = agentOf(event);
    const summary = event.type === "context.compacted";
    const trigger = summary ? payloadOf(event).trigger : undefined;
    facts.set(effectId, {
      ...(agent ? { agentPath: agent.path } : {}),
      ...(agent?.delegationId ? { delegationId: agent.delegationId } : {}),
      summary,
      ...(typeof trigger === "string" ? { trigger } : {}),
    });
  }
  return facts;
}

/** The calls in ledger order, each with its context and what the events say about it. */
export type ContextCall<C extends LedgerCall = LedgerCall> = CallRow<C> &
  Readonly<{ context: number; facts: CallFacts }>;

export function contextCalls<C extends LedgerCall>(
  turns: readonly TurnRow<C>[],
  facts: ReadonlyMap<string, CallFacts>,
): ContextCall<C>[] {
  return turns
    .flatMap((turn) =>
      turn.calls.map((row) => ({
        ...row,
        context: contextOf(row.tokens),
        facts: facts.get(row.call.effectId) ?? { summary: false },
      })),
    )
    .sort((a, b) => a.number - b.number);
}

/** A root-agent call that sent the conversation: not a subagent's, not a summary, with usage. */
function isRootContext(row: ContextCall): boolean {
  return row.recorded && !row.facts.agentPath && !row.facts.summary;
}

export type ContextSummary<C extends LedgerCall = LedgerCall> = Readonly<{
  /** The root agent's last call: the context it sent. */
  last: ContextCall<C>;
  /** Its largest. */
  peak: ContextCall<C>;
  /** Every root-agent call's context, in order, for a sparkline. */
  series: readonly number[];
}>;

/** The root agent's context at its last call and at its peak; null before its first call. */
export function contextSummary<C extends LedgerCall>(
  calls: readonly ContextCall<C>[],
): ContextSummary<C> | null {
  const root = calls.filter(isRootContext);
  if (root.length === 0) return null;
  const peak = root.reduce((best, row) => (row.context > best.context ? row : best));
  return { last: root[root.length - 1]!, peak, series: root.map((row) => row.context) };
}

/** The share of the input the provider read from its cache; null without input. */
export function cacheShare(totals: Pick<Usage, "cachedTokens" | "inputTokens" | "cacheWriteTokens">): number | null {
  const input = totals.cachedTokens + totals.inputTokens + totals.cacheWriteTokens;
  return input > 0 ? totals.cachedTokens / input : null;
}

export type Compaction<C extends LedgerCall = LedgerCall> = Readonly<{
  /** The call that wrote the summary. */
  summary: ContextCall<C>;
  trigger: string | undefined;
  /** The root agent's context at its call before and its call after; null when not yet made. */
  before: number | null;
  after: number | null;
}>;

/**
 * Each compaction of the root agent's context, with the context its calls measured either side.
 * The event's own `tokensBefore`/`tokensAfter` are the harness's estimates, so they are not used.
 */
export function compactionsOf<C extends LedgerCall>(calls: readonly ContextCall<C>[]): Compaction<C>[] {
  return calls.flatMap((row, index) => {
    if (!row.facts.summary || row.facts.agentPath) return [];
    const before = calls.slice(0, index).filter(isRootContext).pop();
    const after = calls.slice(index + 1).find(isRootContext);
    return [{ summary: row, trigger: row.facts.trigger, before: before?.context ?? null, after: after?.context ?? null }];
  });
}

export type SubagentRow = Readonly<{
  path: string;
  /** Its runs: `delegation.started` events for it, else the delegations its calls name. */
  runs: number;
  calls: number;
  peakContext: number;
  tokens: number;
  cost: number;
}>;

/** One row per subagent that made a model call, in the order of its first call. */
export function subagentsOf<C extends LedgerCall>(
  calls: readonly ContextCall<C>[],
  events: readonly EventLike[],
): SubagentRow[] {
  const started = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "delegation.started") continue;
    const path = agentOf(event)?.path;
    if (path) started.set(path, (started.get(path) ?? 0) + 1);
  }
  const rows = new Map<string, ContextCall<C>[]>();
  for (const row of calls) {
    const path = row.facts.agentPath;
    if (!path) continue;
    const list = rows.get(path);
    if (list) list.push(row);
    else rows.set(path, [row]);
  }
  return [...rows].map(([path, list]) => {
    const delegations = new Set(list.map((row) => row.facts.delegationId).filter(Boolean));
    return {
      path,
      runs: started.get(path) ?? Math.max(1, delegations.size),
      calls: list.length,
      peakContext: Math.max(0, ...list.map((row) => row.context)),
      tokens: list.reduce((sum, row) => sum + row.total, 0),
      cost: list.reduce((sum, row) => sum + row.cost, 0),
    };
  });
}

/** What the call chart's bars measure. */
export type ChartMeasure = "tokens" | "cost";

/** One bar: its segments by kind (bottom first) and the part of the cost not split by kind. */
export type ChartBar = Readonly<{
  segments: Readonly<Record<TokenKind, number>>;
  unsplit: number;
  total: number;
}>;

/**
 * Each call's bar in tokens or in cost, by kind. A call recorded before cost was split by kind
 * puts its whole cost in `unsplit`.
 */
export function chartBar(row: CallRow, measure: ChartMeasure): ChartBar {
  if (measure === "tokens") return { segments: row.tokens, unsplit: 0, total: row.total };
  const split = row.call.usage?.costSplit ?? null;
  if (split === null) return { segments: NO_TOKENS, unsplit: row.cost, total: row.cost };
  const segments = { cacheRead: split.cacheRead, input: split.input, cacheWrite: split.cacheWrite, output: split.output };
  return { segments, unsplit: 0, total: segments.cacheRead + segments.input + segments.cacheWrite + segments.output };
}

/**
 * The context the root agent sent at its latest model call, from the session's events (newest or
 * oldest first): its `message.assistant`'s usage as the harness reported it. Null before one.
 */
export function latestContext(events: readonly (EventLike & Readonly<{ seq?: number }>)[]): number | null {
  let bestSeq = -Infinity;
  let best: number | null = null;
  for (const event of events) {
    if (event.type !== "message.assistant" || agentOf(event)) continue;
    const usage = payloadOf(event).usage;
    if (usage === null || typeof usage !== "object") continue;
    const { inputTokens, cachedTokens, cacheWriteTokens } = usage as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const context = n(inputTokens) + n(cachedTokens) + n(cacheWriteTokens);
    if (context <= 0) continue;
    const seq = typeof event.seq === "number" ? event.seq : -1;
    if (best === null || seq > bestSeq) {
      bestSeq = seq;
      best = context;
    }
  }
  return best;
}

/** A token count at a glance: `912`, `17.2k`, `184k`, `1.2M`. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 100_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
