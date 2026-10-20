import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MoreVertical } from "lucide-react";
import type { ModelCall, SessionUsageTotals } from "@nylorun/agents";
import type { StudioEvent } from "@/event-presentation";
import { createTenantClient } from "@/proxy-client";
import { fullTime, shortTime } from "@/time-format";
import { formatTokens, usageNotes } from "@/usage-format";
import {
  callEvents,
  formatDuration,
  formatShare,
  ledgerCost,
  sessionLedger,
  turnsOf,
  type CallRow,
  type LedgerRow,
  type TokenKind,
  type Tokens,
} from "@/usage-ledger";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const SESSION_READS = "session-reads";
const CALLS_PAGE = 50;

/**
 * One colour per token kind, the same in the session bar, the call bars and the column heads:
 * DESIGN.md's Sage series, dark to light.
 */
const KIND_COLOR: Record<TokenKind, string> = {
  cacheRead: "bg-chart-1",
  input: "bg-chart-2",
  cacheWrite: "bg-chart-3",
  output: "bg-chart-4",
};
const KIND_COLUMN: Record<TokenKind, string> = {
  cacheRead: "Cached",
  input: "Uncached",
  cacheWrite: "Cache write",
  output: "Output",
};

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

/** Tokens by kind as one stacked bar, `scale` tokens wide. */
function TokenBar({
  tokens,
  kinds,
  scale,
  className,
}: Readonly<{ tokens: Tokens; kinds: readonly TokenKind[]; scale: number; className?: string }>) {
  return (
    <div aria-hidden className={cn("flex gap-px overflow-hidden rounded-[3px]", className)}>
      {kinds.map((kind) =>
        tokens[kind] > 0 ? (
          <span
            key={kind}
            className={cn("block min-w-px", KIND_COLOR[kind])}
            style={{ width: `${scale > 0 ? (tokens[kind] / scale) * 100 : 0}%` }}
          />
        ) : null,
      )}
    </div>
  );
}

const numberCell = "text-right text-xs tabular-nums";

/** The ledger columns every row shares: tokens by kind, total, time and cost. */
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
      <TableCell className={numberCell}>{formatTokens(row.total)}</TableCell>
      <TableCell className={cn(numberCell, "text-muted-foreground")}>
        {row.durationMs === null ? "—" : formatDuration(row.durationMs)}
      </TableCell>
      <TableCell className={numberCell}>{cost(row.cost)}</TableCell>
    </>
  );
}

/**
 * The session's recorded model usage (Host feature `session-reads`) as one ledger: the session,
 * then its turns, then each turn's model calls, with the same measures at every level. A call's
 * menu opens the event that records it. Read again whenever `revision` changes (a turn ended).
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
        const [totals, page] = await Promise.all([
          session.usage({ signal: abort.signal }),
          session.modelCalls({ limit: CALLS_PAGE, signal: abort.signal }),
        ]);
        if (!abort.signal.aborted)
          setState({ kind: "ready", totals, calls: page.calls, nextCursor: page.nextCursor });
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
  const calls = state.kind === "ready" ? state.calls : [];
  const turns = useMemo(() => turnsOf(calls), [calls]);
  const turnCount = useMemo(() => {
    const ids = new Set<string>(calls.map((call) => call.turnId));
    for (const event of events) if (event.type.startsWith("turn.") && event.turnId) ids.add(event.turnId);
    return ids.size;
  }, [calls, events]);

  if (state.kind === "loading")
    return <p className="p-4 text-sm text-muted-foreground">Loading usage…</p>;
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
  const scale = Math.max(0, ...turns.flatMap((turn) => turn.calls.map((row) => row.total)));
  const toggle = (turnId: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-4 p-4">
        <section aria-label="Session" className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-sm font-medium" title={`As of ${fullTime(totals.asOf)}`}>
              Session
            </h2>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{formatTokens(totals.calls)}</span>{" "}
              model {totals.calls === 1 ? "call" : "calls"}
              {totals.timedCalls > 0 ? (
                <>
                  {" · "}
                  <span
                    className="font-medium text-foreground tabular-nums"
                    title={
                      totals.timedCalls < totals.calls
                        ? `Over the ${totals.timedCalls} of ${totals.calls} calls that were timed`
                        : "Each call's duration, added up"
                    }
                  >
                    {formatDuration(totals.modelTimeMs)}
                  </span>{" "}
                  model time
                </>
              ) : null}
              {" · "}
              {turnCount} {turnCount === 1 ? "turn" : "turns"}
            </p>
          </div>
          <TokenBar
            tokens={{
              cacheRead: totals.cachedTokens,
              input: totals.inputTokens,
              cacheWrite: totals.cacheWriteTokens,
              output: totals.outputTokens,
            }}
            kinds={kinds}
            scale={ledger.totalTokens}
            className="h-3.5"
          />
          <table className="w-full max-w-xl text-xs">
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
                <td className="pt-2 text-right text-sm">{formatTokens(ledger.totalTokens)}</td>
                <td />
                <td className="pt-2 text-right text-sm">{cost(ledger.totalCost)}</td>
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

        <section aria-label="Model calls" className="space-y-2">
          <h3 className="text-sm font-medium">Model calls</h3>
          {calls.length === 0 ? (
            <p className="text-sm text-muted-foreground">No model calls yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Call</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead className="w-full min-w-20">
                    <span className="sr-only">Tokens</span>
                  </TableHead>
                  {kinds.map((kind) => (
                    <TableHead key={kind} className="text-right">
                      <span className="inline-flex items-center gap-1.5">
                        <Swatch kind={kind} />
                        {KIND_COLUMN[kind]}
                      </span>
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Total</TableHead>
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
                  return (
                    <Fragment key={turn.turnId}>
                      <TableRow className="bg-muted/50 font-medium hover:bg-muted/50">
                        <TableCell className="whitespace-nowrap text-xs">
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => toggle(turn.turnId)}
                            className="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title={turn.turnId}
                          >
                            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                            Turn {turn.number}
                          </button>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs font-normal tabular-nums text-muted-foreground">
                          <time dateTime={turn.start} title={fullTime(turn.start)}>
                            {shortTime(turn.start)}
                          </time>
                        </TableCell>
                        <TableCell className="text-xs font-normal text-muted-foreground">
                          {turn.calls.length} {turn.calls.length === 1 ? "call" : "calls"}
                        </TableCell>
                        <LedgerCells row={turn} kinds={kinds} cost={cost} />
                        <TableCell />
                      </TableRow>
                      {open
                        ? turn.calls.map((row) => (
                            <CallLine
                              key={row.call.id}
                              row={row}
                              kinds={kinds}
                              scale={scale}
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
      </div>
    </ScrollArea>
  );
}

function CallLine({
  row,
  kinds,
  scale,
  cost,
  event,
  onViewEvent,
}: Readonly<{
  row: CallRow<ModelCall>;
  kinds: readonly TokenKind[];
  scale: number;
  cost: (usd: number) => string;
  event: StudioEvent | undefined;
  onViewEvent: (event: StudioEvent) => void;
}>) {
  const { call } = row;
  const model = [call.provider, call.model].filter(Boolean).join(" · ");
  return (
    <TableRow className="group">
      <TableCell className="whitespace-nowrap text-xs tabular-nums">
        <span className="inline-flex items-center gap-1.5 pl-5" title={model || undefined}>
          #{row.number}
          {call.usage?.duplicate ? <Badge variant="outline">duplicate</Badge> : null}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        <time dateTime={row.start} title={fullTime(row.start)}>
          {shortTime(row.start)}
        </time>
      </TableCell>
      <TableCell>
        <TokenBar tokens={row.tokens} kinds={kinds} scale={scale} className="h-2 max-w-56" />
      </TableCell>
      {row.recorded ? (
        <LedgerCells row={row} kinds={kinds} cost={cost} />
      ) : (
        <TableCell colSpan={kinds.length + 3} className="text-right text-xs text-muted-foreground">
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
