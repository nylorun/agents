import { useCallback, useEffect, useState } from "react";
import type { ModelCall, SessionUsageTotals } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { fullTime, shortTime } from "@/time-format";
import { formatCost, formatTokens, usageNotes } from "@/usage-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

function Stat({ label, value, hint }: Readonly<{ label: string; value: string; hint?: string }>) {
  return (
    <div className="rounded-lg border p-3" title={hint}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * The session's recorded model usage (Host feature `session-reads`): its totals, then each model
 * call with its tokens and cost. Read again whenever `revision` changes (a turn ended).
 */
export function SessionUsage({
  tenantId,
  sessionId,
  revision,
}: Readonly<{ tenantId: string; sessionId: string; revision: string }>) {
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
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
      <p role="alert" className="p-4 text-sm text-red-600">
        {state.message}
      </p>
    );

  const { totals, calls } = state;
  const notes = usageNotes(totals);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-4 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Token usage</h2>
          <span className="text-xs text-muted-foreground" title={fullTime(totals.asOf)}>
            as of {shortTime(totals.asOf)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Stat label="Total tokens" value={formatTokens(totals.totalTokens)} />
          <Stat label="Input" value={formatTokens(totals.inputTokens)} />
          <Stat label="Output" value={formatTokens(totals.outputTokens)} />
          <Stat
            label="Cost"
            value={formatCost(totals.costUsd)}
            hint="At the model catalog's price; a custom endpoint costs $0."
          />
          <Stat
            label="Cache read"
            value={formatTokens(totals.cachedTokens)}
            hint="Input tokens served from the provider's prompt cache."
          />
          <Stat label="Cache write" value={formatTokens(totals.cacheWriteTokens)} />
          <Stat
            label="Reasoning"
            value={formatTokens(totals.reasoningTokens)}
            hint="Output tokens the model spent reasoning."
          />
          <Stat label="Model calls" value={formatTokens(totals.calls)} />
        </div>
        {notes.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Model calls</h3>
          {calls.length === 0 ? (
            <p className="text-sm text-muted-foreground">No model calls yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cache read</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.map((call) => (
                  <TableRow key={call.id}>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      <time dateTime={call.at} title={fullTime(call.at)}>
                        {shortTime(call.at)}
                      </time>
                    </TableCell>
                    <TableCell className="max-w-48 text-xs">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate" title={[call.provider, call.model].filter(Boolean).join(" · ")}>
                          {call.model ?? "—"}
                        </span>
                        {call.usage?.duplicate ? <Badge variant="outline">duplicate</Badge> : null}
                      </span>
                    </TableCell>
                    {call.usage ? (
                      <>
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatTokens(call.usage.inputTokens)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatTokens(call.usage.outputTokens)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatTokens(call.usage.cachedTokens)}
                        </TableCell>
                        <TableCell className="text-right text-xs font-medium tabular-nums">
                          {formatTokens(call.usage.totalTokens)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {formatCost(call.usage.costUsd)}
                        </TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={5} className="text-right text-xs text-muted-foreground">
                        No usage recorded
                      </TableCell>
                    )}
                  </TableRow>
                ))}
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
