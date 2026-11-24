import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, DollarSign, Hash, Layers, MoreVertical, type LucideIcon } from "lucide-react";
import type { ModelCall, SessionUsageTotals } from "@nylorun/agents";
import type { StudioEvent } from "@/event-presentation";
import { createTenantClient } from "@/proxy-client";
import { fullTime, shortTime } from "@/time-format";
import { formatTokens, usageNotes } from "@/usage-format";
import {
  TOKEN_KINDS,
  cacheShare,
  callEvents,
  callFacts,
  chartBar,
  compactTokens,
  compactionsOf,
  contextCalls,
  contextSummary,
  formatDuration,
  formatShare,
  latestContext,
  ledgerCost,
  sessionLedger,
  subagentsOf,
  turnsOf,
  type ChartMeasure,
  type ContextCall,
  type LedgerRow,
  type TokenKind,
  type Tokens,
} from "@/usage-ledger";
import { cn } from "@/lib/utils";
import { CHART_HAIRLINE } from "@/lib/chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const SESSION_READS = "session-reads";
const CALLS_PAGE = 50;
/** Calls the tab reads on its own before it asks for "Load more calls". */
const CALLS_AUTOLOAD = 1000;

/**
 * One colour per token kind, the same in the session bar, the call chart and the column heads:
 * Studio's chart series in order, light to dark. Chart-4 and chart-3 are under 3:1 on white, so they
 * carry the chart hairline (`CHART_HAIRLINE`).
 */
const KIND_COLOR: Record<TokenKind, string> = {
  cacheRead: cn("bg-chart-4", CHART_HAIRLINE),
  input: cn("bg-chart-3", CHART_HAIRLINE),
  cacheWrite: "bg-chart-2",
  output: "bg-chart-1",
};
/** Inside a 6px bar a hairline would hide the fill, so the chart's segments go without it. */
const KIND_FILL: Record<TokenKind, string> = {
  cacheRead: "bg-chart-4",
  input: "bg-chart-3",
  cacheWrite: "bg-chart-2",
  output: "bg-chart-1",
};
const KIND_COLUMN: Record<TokenKind, string> = {
  cacheRead: "Cached",
  input: "Uncached",
  cacheWrite: "Cache write",
  output: "Output",
};
/** Stacked bottom to top: the input kinds (the context), then the output. */
const STACK: readonly TokenKind[] = ["cacheRead", "input", "cacheWrite", "output"];

type UsageState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      totals: SessionUsageTotals;
      calls: readonly ModelCall[];
      nextCursor: string | null;
    };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function Swatch({ kind }: Readonly<{ kind: TokenKind }>) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-[2px]", KIND_COLOR[kind])} />;
}

/**
 * Tokens by kind as one stacked bar, as wide as its share of `scale` tokens. The segments share
 * that width by flex proportion, after their 1px gaps, so none is clipped.
 */
function TokenBar({
  tokens,
  kinds,
  scale,
  className,
}: Readonly<{ tokens: Tokens; kinds: readonly TokenKind[]; scale: number; className?: string }>) {
  const total = kinds.reduce((sum, kind) => sum + tokens[kind], 0);
  return (
    <div aria-hidden className={cn("flex", className)}>
      <div
        className="flex h-full gap-px overflow-hidden rounded-[2px]"
        style={{ width: `${scale > 0 ? Math.min(1, total / scale) * 100 : 0}%` }}
      >
        {kinds.map((kind) =>
          tokens[kind] > 0 ? (
            <span
              key={kind}
              className={cn("block h-full min-w-px", KIND_COLOR[kind])}
              style={{ flex: `${tokens[kind]} 1 0` }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

/** The models a turn's calls used: one by name, several by count. */
function turnModels(calls: readonly ContextCall<ModelCall>[]): { label: string; title: string } {
  const models = [...new Set(calls.map(({ call }) => call.model).filter(Boolean))];
  if (models.length <= 1) return { label: models[0] ?? "—", title: models[0] ?? "" };
  return { label: `${models.length} models`, title: models.join(", ") };
}

/** While the ledger loads: its summary, the chart and a few call rows, as grey bars. */
function UsageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading usage" className="space-y-4 p-4">
      <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {[0, 1].map((cell) => (
          <div key={cell} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-36 w-full" />
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-8 w-full" />
      ))}
    </div>
  );
}

const numberCell = "text-right tabular-nums";

/** The columns every ledger row shares: tokens by kind, time and cost. */
function LedgerCells({
  row,
  kinds,
  cost,
}: Readonly<{ row: LedgerRow; kinds: readonly TokenKind[]; cost: (usd: number) => string }>) {
  return (
    <>
      {kinds.map((kind) => (
        <TableCell key={kind} className={numberCell}>
          {formatTokens(row.tokens[kind])}
        </TableCell>
      ))}
      <TableCell className={cn(numberCell, "text-muted-foreground")}>
        {row.durationMs === null ? "—" : formatDuration(row.durationMs)}
      </TableCell>
      <TableCell className={numberCell}>{cost(row.cost)}</TableCell>
    </>
  );
}

/**
 * The context the root agent sent at its latest model call, as a chip for the session header:
 * read from the session's events, so it moves with every call. Hidden before the first.
 */
export function ContextChip({
  events,
  onOpen,
}: Readonly<{ events: readonly StudioEvent[]; onOpen: () => void }>) {
  const context = useMemo(() => latestContext(events), [events]);
  if (context === null) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onOpen}
      title={`${formatTokens(context)} tokens sent at the agent's last model call. Open Usage`}
      className="h-6 gap-1.5 bg-muted px-2 text-xs font-normal hover:bg-accent"
    >
      <Layers aria-hidden className="size-3 text-muted-foreground" />
      <span className="font-mono tabular-nums">{compactTokens(context)}</span>
      <span className="text-muted-foreground">in context</span>
    </Button>
  );
}

/** An icon-only option of the chart's switch; its label names it for the tooltip and readers. */
function MeasureToggle({
  value,
  label,
  icon: Icon,
}: Readonly<{ value: ChartMeasure; label: string; icon: LucideIcon }>) {
  return (
    <Tooltip>
      {/* A wrapper triggers the tooltip so the item keeps its own data-state (on/off). */}
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <ToggleGroupItem
            value={value}
            aria-label={label}
            className="size-7 min-w-7 rounded-md! px-0 text-muted-foreground hover:bg-transparent data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm!"
          >
            <Icon className="size-3.5" />
          </ToggleGroupItem>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const CHART_HEIGHT = "h-36";

/**
 * One thin bar per model call, in call order, stacked by token kind: the input kinds add up to the
 * context the call sent, the output sits on top. In cost, the same kinds by what they cost. Bars
 * keep their width and scroll sideways rather than squeeze. A dashed line marks a compaction.
 */
function CallChart({
  calls,
  cost,
}: Readonly<{ calls: readonly ContextCall<ModelCall>[]; cost: (usd: number) => string }>) {
  const [measure, setMeasure] = useState<ChartMeasure>("tokens");
  const bars = calls.map((row) => chartBar(row, measure));
  const max = Math.max(0, ...bars.map((bar) => bar.total));
  const label = (value: number) => (measure === "tokens" ? compactTokens(value) : cost(value));
  const anyUnsplit = measure === "cost" && bars.some((bar) => bar.unsplit > 0);
  const compacted = calls.some((row) => row.facts.summary && !row.facts.agentPath);
  const kinds = STACK.filter((kind) => bars.some((bar) => bar.segments[kind] > 0));
  const largest = calls.reduce<ContextCall<ModelCall> | undefined>(
    (best, row, index) => (best === undefined || bars[index]!.total > chartBar(best, measure).total ? row : best),
    undefined,
  );
  return (
    <section aria-label="Model calls chart" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Model calls</h2>
        <ToggleGroup
          type="single"
          size="sm"
          value={measure}
          onValueChange={(value) => {
            if (value === "tokens" || value === "cost") setMeasure(value);
          }}
          aria-label="Bar height"
          className="shrink-0 gap-0.5 rounded-lg bg-muted p-0.5"
        >
          <MeasureToggle value="tokens" label="Show tokens" icon={Hash} />
          <MeasureToggle value="cost" label="Show cost" icon={DollarSign} />
        </ToggleGroup>
      </div>
      <div className="flex gap-2">
        <div
          aria-hidden
          className={cn(
            "flex min-w-9 flex-col justify-between text-right text-[11px] tabular-nums text-muted-foreground",
            CHART_HEIGHT,
          )}
        >
          <span>{label(max)}</span>
          <span>{label(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
          <div
            role="img"
            aria-label={
              `${measure === "tokens" ? "Tokens" : "Cost"} of each of ${calls.length} model calls` +
              (largest ? `; the largest is call ${largest.number}, ${label(chartBar(largest, measure).total)}` : "") +
              (compacted ? "; the context was compacted" : "")
            }
            className={cn("relative flex w-max min-w-full items-end gap-[3px] border-b border-ring", CHART_HEIGHT)}
          >
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-muted" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-muted" />
            {calls.map((row, index) => {
              const bar = bars[index]!;
              const afterCompaction =
                index > 0 && calls[index - 1]!.facts.summary && !calls[index - 1]!.facts.agentPath;
              const tags = [row.facts.agentPath, row.facts.summary ? "compaction summary" : undefined]
                .filter(Boolean)
                .join(" · ");
              return (
                <Fragment key={row.call.id}>
                {afterCompaction ? (
                  <span aria-hidden className="relative h-full w-0 shrink-0 border-l border-dashed border-foreground" />
                ) : null}
                <span
                  title={
                    `#${row.number}${tags ? ` · ${tags}` : ""} · context ${formatTokens(row.context)}` +
                    ` · output ${formatTokens(row.tokens.output)} · ${cost(row.cost)}`
                  }
                  className={cn(
                    "relative flex h-full w-1.5 shrink-0 flex-col-reverse hover:opacity-75",
                    row.facts.summary && "opacity-60",
                  )}
                >
                  {STACK.map((kind) =>
                    bar.segments[kind] > 0 && max > 0 ? (
                      <span
                        key={kind}
                        className={cn("block w-1.5 shrink-0", KIND_FILL[kind], kind === "output" && "rounded-t-[1px]")}
                        style={{ height: `${(bar.segments[kind] / max) * 100}%` }}
                      />
                    ) : null,
                  )}
                  {bar.unsplit > 0 && max > 0 ? (
                    <span className="block w-1.5 shrink-0 bg-ring" style={{ height: `${(bar.unsplit / max) * 100}%` }} />
                  ) : null}
                </span>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-3.5 gap-y-1 pl-11 text-xs text-muted-foreground">
        {kinds.map((kind) => (
          <li key={kind} className="inline-flex items-center gap-1.5">
            <Swatch kind={kind} />
            {TOKEN_KINDS.find((entry) => entry.kind === kind)!.label}
          </li>
        ))}
        {anyUnsplit ? (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-[2px] bg-ring" />
            Not split by kind
          </li>
        ) : null}
        {compacted ? (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 border-l border-dashed border-foreground" />
            Compacted
          </li>
        ) : null}
        {measure === "tokens" ? <li>The input kinds add up to the context each call sent</li> : null}
      </ul>
    </section>
  );
}

/**
 * The session's recorded model usage (Host feature `session-reads`), built around the model call:
 * the context the agent sent at its last call beside what the session sent in all, one chart of
 * every call, its compactions, the split by token kind, the calls by turn and the subagents. Every
 * figure comes from the usage and model-call reads, joined to the session's events by effect id.
 * Read again whenever `revision` changes (a turn ended).
 */
export function SessionUsage({
  tenantId,
  sessionId,
  revision,
  events,
  onViewEvent,
}: Readonly<{
  tenantId: string;
  sessionId: string;
  revision: string;
  events: readonly StudioEvent[];
  onViewEvent: (event: StudioEvent) => void;
}>) {
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const abort = new AbortController();
    const client = createTenantClient(tenantId);
    const session = client.session(sessionId);
    void (async () => {
      try {
        const features = await client.hostFeatures({ signal: abort.signal });
        if (abort.signal.aborted) return;
        if (!features.includes(SESSION_READS)) return setState({ kind: "unsupported" });
        const [totals, first] = await Promise.all([
          session.usage({ signal: abort.signal }),
          session.modelCalls({ limit: CALLS_PAGE, signal: abort.signal }),
        ]);
        // The context figures need the session's latest calls, so read on to the end, up to a cap.
        let calls: readonly ModelCall[] = first.calls;
        let nextCursor = first.nextCursor;
        while (nextCursor !== null && calls.length < CALLS_AUTOLOAD && !abort.signal.aborted) {
          const page = await session.modelCalls({ limit: CALLS_PAGE, cursor: nextCursor, signal: abort.signal });
          calls = [...calls, ...page.calls];
          nextCursor = page.nextCursor;
        }
        if (!abort.signal.aborted) setState({ kind: "ready", totals, calls, nextCursor });
      } catch (cause) {
        if (!abort.signal.aborted) setState({ kind: "failed", message: messageOf(cause) });
      }
    })();
    return () => abort.abort();
  }, [tenantId, sessionId, revision]);

  const cursor = state.kind === "ready" ? state.nextCursor : null;
  const loadMore = useCallback(() => {
    if (cursor === null) return;
    setLoadingMore(true);
    createTenantClient(tenantId)
      .session(sessionId)
      .modelCalls({ limit: CALLS_PAGE, cursor })
      .then(
        (page) =>
          setState((previous) =>
            previous.kind === "ready" && previous.nextCursor === cursor
              ? {
                  ...previous,
                  calls: [...previous.calls, ...page.calls],
                  nextCursor: page.nextCursor,
                }
              : previous,
          ),
        (cause: unknown) => setState({ kind: "failed", message: messageOf(cause) }),
      )
      .finally(() => setLoadingMore(false));
  }, [tenantId, sessionId, cursor]);

  const eventsByCall = useMemo(() => callEvents(events), [events]);
  const facts = useMemo(() => callFacts(eventsByCall), [eventsByCall]);
  const calls = state.kind === "ready" ? state.calls : [];
  const turns = useMemo(() => turnsOf(calls), [calls]);
  const rows = useMemo(() => contextCalls(turns, facts), [turns, facts]);
  const turnCount = useMemo(() => {
    const ids = new Set<string>(calls.map((call) => call.turnId));
    for (const event of events) if (event.type.startsWith("turn.") && event.turnId) ids.add(event.turnId);
    return ids.size;
  }, [calls, events]);

  if (state.kind === "loading") return <UsageSkeleton />;
  if (state.kind === "unsupported")
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This Runtime does not report a session's usage (Host feature <code>session-reads</code>).
      </p>
    );
  if (state.kind === "failed")
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {state.message}
      </p>
    );

  const { totals } = state;
  const ledger = sessionLedger(totals);
  const cost = ledgerCost(totals.costUsd);
  const kinds = ledger.parts.map((part) => part.kind);
  const notes = usageNotes(totals);
  const context = contextSummary(rows);
  const share = cacheShare(totals);
  const compactions = compactionsOf(rows);
  const subagents = subagentsOf(rows, events);
  const partial = state.nextCursor !== null;
  const rowsByTurn = new Map<string, ContextCall<ModelCall>[]>();
  for (const row of rows) {
    const list = rowsByTurn.get(row.call.turnId);
    if (list) list.push(row);
    else rowsByTurn.set(row.call.turnId, [row]);
  }
  const toggle = (turnId: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });

  return (
    // Radix sizes the viewport's child as a table, which grows to the widest row: keep it to the panel.
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
      <div className="space-y-7 p-4">
        <section aria-label="Session" className="space-y-2">
          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <p className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium">Context at last call</span>
                {context ? (
                  <span className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground tabular-nums">{formatTokens(context.last.context)}</span>{" "}
                    tokens
                  </span>
                ) : null}
              </p>
              {context ? (
                <>
                  <div aria-hidden className="flex h-3 items-end gap-px">
                    {context.series.map((value, index) => (
                      <span
                        key={index}
                        className="block max-w-1.5 flex-1 bg-chart-2"
                        style={{ height: `${(value / Math.max(1, context.peak.context)) * 100}%` }}
                      />
                    ))}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    Call #{context.last.number}
                    {context.last.call.model ? ` · ${context.last.call.model}` : ""} · peak{" "}
                    {compactTokens(context.peak.context)} at #{context.peak.number}
                    {partial ? ` · first ${calls.length} calls` : ""}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">No model call has reported its tokens yet.</p>
              )}
            </div>
            <div className="min-w-0 space-y-1.5">
              <p className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium" title={`As of ${fullTime(totals.asOf)}`}>
                  Sent this session
                </span>
                <span className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground tabular-nums">{cost(ledger.totalCost)}</span> ·{" "}
                  {formatTokens(ledger.totalTokens)} tokens
                </span>
              </p>
              <TokenBar
                tokens={{
                  cacheRead: totals.cachedTokens,
                  input: totals.inputTokens,
                  cacheWrite: totals.cacheWriteTokens,
                  output: totals.outputTokens,
                }}
                kinds={kinds}
                scale={ledger.totalTokens}
                className="h-2"
              />
              <p className="text-xs text-muted-foreground">
                {formatTokens(totals.calls)} {totals.calls === 1 ? "call" : "calls"} · {turnCount}{" "}
                {turnCount === 1 ? "turn" : "turns"}
                {totals.timedCalls > 0 ? (
                  <span
                    title={
                      totals.timedCalls < totals.calls
                        ? `Over the ${totals.timedCalls} of ${totals.calls} calls that were timed`
                        : "Each call's duration, added up"
                    }
                  >
                    {" · "}
                    {formatDuration(totals.modelTimeMs)} model time
                  </span>
                ) : null}
              </p>
            </div>
          </div>
          {share !== null && totals.calls > 1 ? (
            <p className="text-xs text-muted-foreground">
              Each call resends the context:{" "}
              {formatTokens(totals.cachedTokens + totals.inputTokens + totals.cacheWriteTokens)} input tokens in all,{" "}
              {formatShare(share)} read from cache.
            </p>
          ) : null}
        </section>

        {rows.length > 0 ? <CallChart calls={rows} cost={cost} /> : null}

        {compactions.length > 0 ? (
          <section aria-label="Compactions" className="space-y-2">
            <h2 className="text-sm font-semibold">Compactions</h2>
            <table className="w-full max-w-xl text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-2 font-normal">When</th>
                  <th scope="col" className="px-2 py-1.5 font-normal">Why</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Context before → after</th>
                  <th scope="col" className="py-1.5 pl-2 text-right font-normal">Summary call</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {compactions.map(({ summary, trigger, before, after }) => (
                  <tr key={summary.call.id} className="border-b border-border/50">
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      #{summary.number} ·{" "}
                      <time dateTime={summary.start} title={fullTime(summary.start)}>
                        {shortTime(summary.start)}
                      </time>
                    </td>
                    <td className="px-2 py-1.5">
                      {trigger === "overflow" ? "The window overflowed" : trigger === "threshold" ? "Reached the threshold" : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {before === null ? "—" : compactTokens(before)} → {after === null ? "next call" : compactTokens(after)}
                    </td>
                    <td className="py-1.5 pl-2 text-right text-muted-foreground">
                      {summary.durationMs === null ? "" : `${formatDuration(summary.durationMs)} · `}
                      {cost(summary.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <section aria-label="By token kind" className="space-y-2">
          <h2 className="text-sm font-semibold">By token kind</h2>
          <table className="w-full max-w-xl text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="py-1.5 text-left font-normal">
                  <span className="sr-only">Kind</span>
                </th>
                <th scope="col" className="py-1.5 text-right font-normal">Tokens</th>
                <th scope="col" className="w-12 py-1.5">
                  <span className="sr-only">Share of tokens</span>
                </th>
                <th scope="col" className="py-1.5 text-right font-normal">Cost</th>
                <th scope="col" className="w-12 py-1.5">
                  <span className="sr-only">Share of cost</span>
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {ledger.parts.map((part) => (
                <tr key={part.kind} className="border-b border-border/50">
                  <th scope="row" className="py-1.5 text-left font-normal">
                    <span className="inline-flex items-center gap-2">
                      <Swatch kind={part.kind} />
                      {part.label}
                    </span>
                  </th>
                  <td className="py-1.5 text-right">{formatTokens(part.tokens)}</td>
                  <td className="py-1.5 text-right text-muted-foreground">{formatShare(part.tokenShare)}</td>
                  <td className="py-1.5 text-right">{part.cost === null ? "—" : cost(part.cost)}</td>
                  <td className="py-1.5 text-right text-muted-foreground">
                    {part.costShare === null ? "" : formatShare(part.costShare)}
                  </td>
                </tr>
              ))}
              {ledger.unsplitCost > 0 ? (
                <tr className="border-b border-border/50">
                  <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                    Recorded before the split
                  </th>
                  <td />
                  <td />
                  <td className="py-1.5 text-right">{cost(ledger.unsplitCost)}</td>
                  <td className="py-1.5 text-right text-muted-foreground">
                    {formatShare(ledger.unsplitCost / ledger.totalCost)}
                  </td>
                </tr>
              ) : null}
              <tr className="border-t border-foreground font-semibold">
                <th scope="row" className="pt-2 text-left">Total</th>
                <td className="pt-2 text-right">{formatTokens(ledger.totalTokens)}</td>
                <td />
                <td className="pt-2 text-right">{cost(ledger.totalCost)}</td>
                <td />
              </tr>
            </tbody>
          </table>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {ledger.reasoningTokens > 0 ? (
              <li>Output includes {formatTokens(ledger.reasoningTokens)} reasoning tokens.</li>
            ) : null}
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>

        <section aria-label="Calls by turn" className="space-y-2">
          <h2 className="text-sm font-semibold">Calls by turn</h2>
          {calls.length === 0 ? (
            <p className="text-sm text-muted-foreground">No model calls yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Call</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right" title="The input the call sent: cached, uncached and cache write">
                    Context
                  </TableHead>
                  {kinds.map((kind) => (
                    <TableHead key={kind} className="text-right">
                      <span className="inline-flex items-center gap-1.5">
                        <Swatch kind={kind} />
                        {KIND_COLUMN[kind]}
                      </span>
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Time</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {turns.map((turn) => {
                  const open = !collapsed.has(turn.turnId);
                  const turnRows = rowsByTurn.get(turn.turnId) ?? [];
                  const used = turnModels(turnRows);
                  const rootPeak = Math.max(
                    0,
                    ...turnRows.filter((row) => !row.facts.agentPath && !row.facts.summary).map((row) => row.context),
                  );
                  return (
                    <Fragment key={turn.turnId}>
                      <TableRow className="bg-muted/50 font-medium hover:bg-muted/50">
                        <TableCell className="whitespace-nowrap">
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => toggle(turn.turnId)}
                            className="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title={turn.turnId}
                          >
                            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                            Turn {turn.number}
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              {turn.calls.length} {turn.calls.length === 1 ? "call" : "calls"}
                            </span>
                          </button>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-normal tabular-nums text-muted-foreground">
                          <time dateTime={turn.start} title={fullTime(turn.start)}>
                            {shortTime(turn.start)}
                          </time>
                        </TableCell>
                        <TableCell className="max-w-48 truncate font-mono text-[13px] font-normal" title={used.title || undefined}>
                          {used.label}
                        </TableCell>
                        <TableCell className={cn(numberCell, "font-normal text-muted-foreground")}>
                          {rootPeak > 0 ? `peak ${compactTokens(rootPeak)}` : "—"}
                        </TableCell>
                        <LedgerCells row={turn} kinds={kinds} cost={cost} />
                        <TableCell />
                      </TableRow>
                      {open
                        ? turnRows.map((row) => (
                            <CallLine
                              key={row.call.id}
                              row={row}
                              kinds={kinds}
                              cost={cost}
                              event={eventsByCall.get(row.call.effectId)}
                              onViewEvent={onViewEvent}
                            />
                          ))
                        : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {state.nextCursor !== null ? (
            <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Loading…" : "Load more calls"}
            </Button>
          ) : null}
        </section>

        {subagents.length > 0 ? (
          <section aria-label="Subagents" className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Subagents</h2>
              <span className="text-xs text-muted-foreground">Each run has its own context</span>
            </div>
            <table className="w-full max-w-xl text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-2 font-normal">Subagent</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Runs</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Calls</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Peak context</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Tokens</th>
                  <th scope="col" className="py-1.5 pl-2 text-right font-normal">Cost</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {subagents.map((agent) => (
                  <tr key={agent.path} className="border-b border-border/50">
                    <td className="py-1.5 pr-2 font-mono text-[13px]">{agent.path}</td>
                    <td className="px-2 py-1.5 text-right">{agent.runs}</td>
                    <td className="px-2 py-1.5 text-right">{agent.calls}</td>
                    <td className="px-2 py-1.5 text-right">{compactTokens(agent.peakContext)}</td>
                    <td className="px-2 py-1.5 text-right">{formatTokens(agent.tokens)}</td>
                    <td className="py-1.5 pl-2 text-right">{cost(agent.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function CallLine({
  row,
  kinds,
  cost,
  event,
  onViewEvent,
}: Readonly<{
  row: ContextCall<ModelCall>;
  kinds: readonly TokenKind[];
  cost: (usd: number) => string;
  event: StudioEvent | undefined;
  onViewEvent: (event: StudioEvent) => void;
}>) {
  const { call } = row;
  const model = [call.provider, call.model].filter(Boolean).join(" · ");
  return (
    <TableRow className="group">
      <TableCell className="whitespace-nowrap tabular-nums">
        <span className="inline-flex items-center gap-1.5 pl-5">
          #{row.number}
          {row.facts.agentPath ? (
            <span className="font-mono text-xs text-muted-foreground">{row.facts.agentPath}</span>
          ) : null}
          {row.facts.summary ? <Badge variant="outline">compaction summary</Badge> : null}
          {call.usage?.duplicate ? <Badge variant="outline">duplicate</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
        <time dateTime={row.start} title={fullTime(row.start)}>
          {shortTime(row.start)}
        </time>
      </TableCell>
      <TableCell className="max-w-48 truncate font-mono text-[13px] text-muted-foreground" title={model || undefined}>
        {call.model || "—"}
      </TableCell>
      {row.recorded ? (
        <>
          <TableCell className={numberCell}>{formatTokens(row.context)}</TableCell>
          <LedgerCells row={row} kinds={kinds} cost={cost} />
        </>
      ) : (
        <TableCell colSpan={kinds.length + 3} className="text-right text-muted-foreground">
          No usage recorded
        </TableCell>
      )}
      <TableCell className="w-10 p-0 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More options for call ${row.number}`}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={event === undefined}
              onSelect={() => {
                if (event) onViewEvent(event);
              }}
            >
              <span className="flex flex-col">
                <span>View event</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {event ? event.type : "Not in this session's events"}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
