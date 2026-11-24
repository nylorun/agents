import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { ChevronDown } from "lucide-react";
import type { TurnTrace as TurnTraceBody } from "@nylorun/agents";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createTenantClient } from "@/proxy-client";
import type { StudioEvent } from "@/event-presentation";
import { formatSpanTime, traceLengthMs, traceRows, turnIdsOf, type TraceRow } from "@/turn-trace";

type TraceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "ready"; rows: TraceRow[] }
  | { kind: "failed"; message: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What a span did, in a few words: the model and its tokens, or the tool. */
function factsOf(row: TraceRow): string {
  if (row.operation === "chat") {
    const tokens =
      row.inputTokens !== undefined || row.outputTokens !== undefined
        ? ` · ${row.inputTokens ?? 0} in, ${row.outputTokens ?? 0} out`
        : "";
    return `${row.model ?? "model"}${tokens}`;
  }
  if (row.operation === "execute_tool") return row.tool ?? "";
  return "";
}

/**
 * A turn as a trace: its spans from the per-turn trace route, which builds them from the log on
 * each read, so a turn's trace lasts as long as its session. Telemetry, for the developer: the
 * turn, each model call and each tool call, with times. HTTP attempts and egress are the
 * operator's, in their own tools.
 */
export function TurnTrace({
  tenantId,
  sessionId,
  events,
  turnId,
  onTurn,
  onOpenEvent,
}: Readonly<{
  tenantId: string;
  sessionId: string;
  events: readonly StudioEvent[];
  turnId?: string;
  onTurn: (turnId: string) => void;
  onOpenEvent: (event: StudioEvent) => void;
}>) {
  const turns = useMemo(() => turnIdsOf(events), [events]);
  const current = turnId && turns.includes(turnId) ? turnId : turns.at(-1);
  const ended = useMemo(
    () =>
      events.some(
        (event) =>
          event.turnId === current &&
          (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled"),
      ),
    [events, current],
  );
  const [state, setState] = useState<TraceState>({ kind: "idle" });
  const [selected, setSelected] = useState<string | undefined>();
  useEffect(() => {
    if (!current) return setState({ kind: "idle" });
    const abort = new AbortController();
    const client = createTenantClient(tenantId);
    setState({ kind: "loading" });
    void (async () => {
      try {
        const features = await client.hostFeatures({ signal: abort.signal });
        if (abort.signal.aborted) return;
        if (!features.includes("traces")) return setState({ kind: "unsupported" });
        const trace: TurnTraceBody = await client.session(sessionId).trace(current, { signal: abort.signal });
        if (!abort.signal.aborted) setState({ kind: "ready", rows: traceRows(trace) });
      } catch (cause) {
        if (!abort.signal.aborted) setState({ kind: "failed", message: messageOf(cause) });
      }
    })();
    return () => abort.abort();
    // A turn's spans change only until it ends: read again when it does.
  }, [tenantId, sessionId, current, ended]);

  const rows = state.kind === "ready" ? state.rows : [];
  const length = Math.max(1, traceLengthMs(rows));
  const chosen = rows.find((row) => row.spanId === selected);
  const chosenEvent = chosen?.cursor ? events.find((event) => event.cursor === chosen.cursor) : undefined;
  const turnLabel = (id: string) => {
    const first = events.find((event) => event.turnId === id);
    return `Turn ${turns.indexOf(id) + 1}${first ? ` · ${dayjs(first.time).format("HH:mm:ss")}` : ""}`;
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <h2 className="text-sm font-semibold">Trace</h2>
        {state.kind === "ready" && rows.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {rows.length} spans · {formatSpanTime(traceLengthMs(rows))}
          </span>
        ) : null}
        {turns.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="ml-auto w-44 justify-between font-normal">
                <span className="truncate">{current ? turnLabel(current) : "No turn"}</span>
                <ChevronDown className="size-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
              {[...turns].reverse().map((id) => (
                <DropdownMenuCheckboxItem key={id} checked={id === current} onCheckedChange={() => onTurn(id)}>
                  {turnLabel(id)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {state.kind === "idle" ? (
          <p className="p-6 text-center text-sm text-muted-foreground">A trace appears when the session runs a turn.</p>
        ) : state.kind === "loading" ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Reading the turn's trace…</p>
        ) : state.kind === "unsupported" ? (
          <p className="p-6 text-center text-sm text-muted-foreground">This Runtime doesn't serve traces (Host feature traces).</p>
        ) : state.kind === "failed" ? (
          <p className="p-6 text-center text-sm text-destructive">{state.message}</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {ended ? "This turn has no spans." : "The turn is still running: its spans appear as its calls end."}
          </p>
        ) : (
          <ul className="divide-y" aria-label="Spans">
            {rows.map((row) => (
              <li key={row.spanId}>
                <button
                  type="button"
                  onClick={() => setSelected(row.spanId === selected ? undefined : row.spanId)}
                  className={`grid w-full grid-cols-[minmax(0,14rem)_minmax(0,1fr)_4.5rem] items-center gap-3 px-4 py-1.5 text-left text-xs hover:bg-muted/50 ${row.spanId === selected ? "bg-muted" : ""}`}
                >
                  <span className="truncate" style={{ paddingLeft: `${row.depth * 12}px` }} title={row.name}>
                    <span className={row.depth === 0 ? "font-medium" : ""}>{row.name}</span>
                    {row.error ? (
                      <Badge variant="destructive" className="ml-1.5 h-4 px-1 text-[10px]">
                        error
                      </Badge>
                    ) : null}
                    <span className="block truncate text-muted-foreground">{factsOf(row)}</span>
                  </span>
                  <span className="relative h-2.5 rounded-sm bg-muted" aria-hidden>
                    <span
                      className={`absolute inset-y-0 rounded-sm ${row.error ? "bg-destructive" : row.operation === "chat" ? "bg-primary" : row.operation === "execute_tool" ? "bg-chart-2" : "bg-muted-foreground/50"}`}
                      style={{
                        left: `${(row.offsetMs / length) * 100}%`,
                        width: `max(2px, ${(row.durationMs / length) * 100}%)`,
                      }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">{formatSpanTime(row.durationMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
      {chosen ? (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t bg-muted/30 px-4 py-3 text-xs">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-medium">{chosen.name}</span>
            <span className="text-muted-foreground">
              at {formatSpanTime(chosen.offsetMs)}, {formatSpanTime(chosen.durationMs)}
            </span>
            {chosenEvent ? (
              <Button variant="outline" size="sm" className="ml-auto h-7" onClick={() => onOpenEvent(chosenEvent)}>
                Open event
              </Button>
            ) : null}
          </div>
          {chosen.errorMessage ? <p className="mb-2 text-destructive">{chosen.errorMessage}</p> : null}
          <dl className="grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono">
            {Object.entries(chosen.attributes)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="truncate text-muted-foreground">{key}</dt>
                  <dd className="truncate" title={String(value)}>
                    {String(value)}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
