import { useEffect, useRef, useState } from "react";
import dayjs from "dayjs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchTenantMetrics } from "@/proxy-client";
import { formatSeconds, perMinute, summarize, type TrafficRead, type TrafficRow, type TrafficSummary } from "@/traffic";

/** How often Traffic reads the Runtime's metrics again. */
const EVERY_MS = 10_000;

type TrafficState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; read: TrafficRead; summary: TrafficSummary; previous?: { at: number; summary: TrafficSummary } };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const number = (value: number) => Math.round(value).toLocaleString("en");

function rateOf(row: TrafficRow, previous: TrafficRow[] | undefined, seconds: number): string {
  const rate = perMinute(previous?.find((p) => p.key === row.key)?.count, row.count, seconds);
  return rate === undefined ? "—" : `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/min`;
}

function Rows({
  title,
  what,
  rows,
  previous,
  seconds,
  empty,
}: Readonly<{
  title: string;
  what: string;
  rows: TrafficRow[];
  previous?: TrafficRow[];
  seconds: number;
  empty: string;
}>) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{what}</TableHead>
              <TableHead className="w-24 text-right">Count</TableHead>
              <TableHead className="w-24 text-right">Now</TableHead>
              <TableHead className="w-20 text-right">Errors</TableHead>
              <TableHead className="w-24 text-right">p50</TableHead>
              <TableHead className="w-24 text-right">p95</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-16 text-center text-sm text-muted-foreground">
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="max-w-0">
                    <span className="block truncate font-mono text-xs" title={row.label}>
                      {row.label}
                    </span>
                    {row.detail || row.extra ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {[row.detail, row.extra].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{number(row.count)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{rateOf(row, previous, seconds)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${row.errors ? "text-destructive" : "text-muted-foreground"}`}>
                    {row.errors === undefined ? "—" : number(row.errors)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatSeconds(row.p50)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatSeconds(row.p95)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * Tenant › Traffic: how the Runtime is running, for the operator on a laptop. API
 * requests by route and client, model calls, tool calls, turns, queue waits and egress, from the
 * runtime's and the gateway's own `/metrics`, read every 10 s. Counts are since each process
 * started; "Now" is the rate between the last two reads. Nothing is stored: history belongs in the
 * team's own tools, over OTLP.
 */
export function TenantTraffic({ tenantId }: Readonly<{ tenantId: string }>) {
  const [state, setState] = useState<TrafficState>({ kind: "loading" });
  const last = useRef<{ at: number; summary: TrafficSummary } | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const body = (await fetchTenantMetrics(tenantId, { signal: abort.signal })) as TrafficRead;
        if (abort.signal.aborted) return;
        if (body.sources.length === 0) return setState({ kind: "off" });
        const summary = summarize(body);
        const previous = last.current;
        last.current = { at: Date.parse(body.at), summary };
        setState({ kind: "ready", read: body, summary, ...(previous ? { previous } : {}) });
      } catch (cause) {
        if (!abort.signal.aborted) setState({ kind: "failed", message: messageOf(cause) });
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void read(), EVERY_MS);
    };
    void read();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [tenantId]);

  if (state.kind === "loading") return <p className="text-sm text-muted-foreground">Reading the Runtime's metrics…</p>;
  if (state.kind === "off")
    return (
      <p className="max-w-prose text-sm text-muted-foreground">
        Traffic reads the Runtime's own metrics from its <code>/metrics</code>. This Studio has no source: set{" "}
        <code>NYLORUN_STUDIO_METRICS_URLS</code>, as <code>nylorun start</code> does.
      </p>
    );
  if (state.kind === "failed") return <p className="text-sm text-destructive">{state.message}</p>;

  const { read, summary, previous } = state;
  const seconds = previous ? (Date.parse(read.at) - previous.at) / 1000 : 0;
  const down = read.sources.filter((s) => !s.ok);
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        From {read.sources.map((s) => s.name).join(" and ")} at {dayjs(read.at).format("HH:mm:ss")}, read every{" "}
        {EVERY_MS / 1000} s. Counts are since each process started; Now is the rate since the last read. For history,
        send OpenTelemetry to your own tools.
      </p>
      {down.length > 0 ? (
        <p className="text-sm text-destructive">
          {down.map((s) => `${s.name}: ${s.error ?? "unreadable"}`).join("; ")}
        </p>
      ) : null}
      {summary.clients.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Requests by client:
          {summary.clients.map((c) => (
            <Badge key={c.client} variant="secondary" className="font-normal">
              {c.client} {number(c.count)}
            </Badge>
          ))}
        </div>
      ) : null}
      <Rows title="API requests" what="Route" rows={summary.requests} previous={previous?.summary.requests} seconds={seconds} empty="No requests yet." />
      <Rows title="Model calls" what="Model" rows={summary.models} previous={previous?.summary.models} seconds={seconds} empty="No model calls yet." />
      <Rows title="Tool calls (MCP)" what="Tool" rows={summary.tools} previous={previous?.summary.tools} seconds={seconds} empty="No MCP tool calls yet." />
      <Rows title="Turns" what="Agent" rows={summary.turns} previous={previous?.summary.turns} seconds={seconds} empty="No turns have ended yet." />
      <Rows title="Queue waits" what="Outcome" rows={summary.queue} previous={previous?.summary.queue} seconds={seconds} empty="No queued messages yet." />
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Egress</h3>
        {summary.egress.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connections out yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2 text-xs">
            {summary.egress.map((e) => (
              <Badge
                key={`${e.outcome}:${e.reason}`}
                variant={e.outcome === "refused" ? "destructive" : "secondary"}
                className="font-normal"
              >
                {e.outcome}
                {e.reason ? ` (${e.reason})` : ""} {number(e.count)}
              </Badge>
            ))}
            {summary.egressBytes.map((b) => (
              <span key={b.direction} className="text-muted-foreground">
                {b.direction} {number(b.bytes)} B
              </span>
            ))}
          </div>
        )}
      </section>
      {summary.dropped > 0 ? (
        <p className="text-xs text-destructive">{number(summary.dropped)} telemetry items were dropped by an exporter.</p>
      ) : null}
    </div>
  );
}
