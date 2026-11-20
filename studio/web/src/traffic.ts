/**
 * Tenant › Traffic (ADR-159): the Runtime's own metrics, as the Studio server read them from each
 * process's `/metrics`, turned into rows. OpenTelemetry names, Prometheus spelling: a name's dots
 * are underscores and counters end `_total`; the Runtime's exporter adds no unit suffix, and one a
 * Prometheus server adds (`_seconds`) is read the same. Counts are since each
 * process started; a rate needs two reads.
 */

export type Sample = Readonly<{ name: string; labels: Readonly<Record<string, string>>; value: number }>;
export type TrafficRead = Readonly<{
  at: string;
  sources: readonly Readonly<{ name: string; ok: boolean; error?: string; samples: readonly Sample[] }>[];
}>;

/** A sample's family: its name without the histogram or counter suffix and the unit. */
export function familyOf(name: string): string {
  return name.replace(/_(bucket|count|sum|total|created)$/, "").replace(/_(seconds|milliseconds)$/, "");
}

const keyOf = (labels: Readonly<Record<string, string>>, by: readonly string[]) =>
  by.map((label) => labels[label] ?? "").join("\u0000");

export interface Histogram {
  key: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  /** Upper bound and cumulative count, by bound. */
  buckets: [number, number][];
}

/** A histogram family's series, summed over every label but `by`, from every source. */
export function histograms(read: TrafficRead, family: string, by: readonly string[], where?: (labels: Readonly<Record<string, string>>) => boolean): Map<string, Histogram> {
  const out = new Map<string, Histogram>();
  for (const source of read.sources)
    for (const s of source.samples) {
      if (familyOf(s.name) !== family || (where && !where(s.labels))) continue;
      const key = keyOf(s.labels, by);
      let h = out.get(key);
      if (!h) {
        h = { key, labels: Object.fromEntries(by.map((l) => [l, s.labels[l] ?? ""])), count: 0, sum: 0, buckets: [] };
        out.set(key, h);
      }
      if (s.name.endsWith("_count")) h.count += s.value;
      else if (s.name.endsWith("_sum")) h.sum += s.value;
      else if (s.name.endsWith("_bucket")) {
        const le = s.labels.le === "+Inf" ? Infinity : Number(s.labels.le);
        const at = h.buckets.find(([bound]) => bound === le);
        if (at) at[1] += s.value;
        else h.buckets.push([le, s.value]);
      }
    }
  for (const h of out.values()) h.buckets.sort((a, b) => a[0] - b[0]);
  return out;
}

/** A counter family's series, summed over every label but `by`. */
export function counters(read: TrafficRead, family: string, by: readonly string[]): Map<string, { labels: Record<string, string>; value: number }> {
  const out = new Map<string, { labels: Record<string, string>; value: number }>();
  for (const source of read.sources)
    for (const s of source.samples) {
      if (familyOf(s.name) !== family || !(s.name.endsWith("_total") || familyOf(s.name) === s.name)) continue;
      const key = keyOf(s.labels, by);
      const row = out.get(key) ?? { labels: Object.fromEntries(by.map((l) => [l, s.labels[l] ?? ""])), value: 0 };
      row.value += s.value;
      out.set(key, row);
    }
  return out;
}

/** A quantile from cumulative buckets, interpolated inside its bucket; undefined with no counts. */
export function quantile(h: Pick<Histogram, "buckets" | "count">, q: number): number | undefined {
  const total = h.count || h.buckets.at(-1)?.[1] || 0;
  if (total <= 0) return undefined;
  const rank = q * total;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const [bound, cumulative] of h.buckets) {
    if (cumulative >= rank) {
      if (!Number.isFinite(bound)) return lowerBound;
      const inBucket = cumulative - lowerCount;
      return inBucket <= 0 ? bound : lowerBound + ((bound - lowerBound) * (rank - lowerCount)) / inBucket;
    }
    lowerBound = bound;
    lowerCount = cumulative;
  }
  return lowerBound;
}

/** Per minute between two reads; undefined for the first read, or a process that restarted. */
export function perMinute(previous: number | undefined, current: number, seconds: number): number | undefined {
  if (previous === undefined || seconds <= 0 || current < previous) return undefined;
  return ((current - previous) / seconds) * 60;
}

export interface TrafficRow {
  key: string;
  /** What the row is: a route, a model, a tool, an outcome. */
  label: string;
  detail?: string;
  count: number;
  errors?: number;
  p50?: number;
  p95?: number;
  /** Extra figures, such as tokens. */
  extra?: string;
}

const isError = (labels: Readonly<Record<string, string>>) => (labels.error_type ?? "") !== "";

function timedRows(read: TrafficRead, family: string, by: readonly string[], label: (labels: Record<string, string>) => string, detail?: (labels: Record<string, string>) => string | undefined, errorOf: (labels: Readonly<Record<string, string>>) => boolean = isError): TrafficRow[] {
  const all = histograms(read, family, by);
  const errors = histograms(read, family, by, errorOf);
  return [...all.values()]
    .map((h) => ({
      key: h.key,
      label: label(h.labels),
      detail: detail?.(h.labels),
      count: h.count,
      errors: errors.get(h.key)?.count ?? 0,
      p50: quantile(h, 0.5),
      p95: quantile(h, 0.95),
    }))
    .sort((a, b) => b.count - a.count);
}

export interface TrafficSummary {
  requests: TrafficRow[];
  clients: { client: string; count: number }[];
  models: TrafficRow[];
  tools: TrafficRow[];
  turns: TrafficRow[];
  queue: TrafficRow[];
  egress: { outcome: string; reason: string; count: number }[];
  egressBytes: { direction: string; bytes: number }[];
  dropped: number;
}

/** Everything the Traffic tab shows from one read. */
export function summarize(read: TrafficRead): TrafficSummary {
  // Token usage is a counter at the pinned conventions' commit.
  const tokens = (direction: "input" | "output") =>
    counters(read, `gen_ai_client_inference_usage_${direction}_tokens`, ["gen_ai_provider_name", "gen_ai_request_model"]);
  const input = tokens("input");
  const output = tokens("output");
  const models = timedRows(read, "gen_ai_client_inference_duration", ["gen_ai_provider_name", "gen_ai_request_model"], (l) => l.gen_ai_request_model || "model", (l) => l.gen_ai_provider_name || undefined).map((row) => ({
    ...row,
    extra: `${Math.round(input.get(row.key)?.value ?? 0).toLocaleString("en")} in, ${Math.round(output.get(row.key)?.value ?? 0).toLocaleString("en")} out`,
  }));
  return {
    requests: timedRows(
      read,
      "http_server_request_duration",
      ["http_request_method", "http_route"],
      (l) => `${l.http_request_method} ${l.http_route || "other"}`,
      undefined,
      (l) => Number(l.http_response_status_code ?? 0) >= 500,
    ),
    clients: [...histograms(read, "http_server_request_duration", ["nylorun_client"]).values()]
      .map((h) => ({ client: h.labels.nylorun_client || "other", count: h.count }))
      .sort((a, b) => b.count - a.count),
    models,
    tools: timedRows(read, "mcp_client_operation_duration", ["gen_ai_tool_name", "mcp_method_name"], (l) => l.gen_ai_tool_name || l.mcp_method_name || "tool", (l) => l.mcp_method_name || undefined),
    turns: timedRows(read, "gen_ai_invoke_agent_duration", ["gen_ai_agent_name"], (l) => l.gen_ai_agent_name || "agent"),
    queue: timedRows(read, "nylorun_queue_wait", ["nylorun_queue_outcome"], (l) => l.nylorun_queue_outcome || "taken", undefined, () => false),
    egress: [...counters(read, "nylorun_egress_connections", ["nylorun_egress_outcome", "nylorun_egress_reason"]).values()]
      .map((c) => ({ outcome: c.labels.nylorun_egress_outcome || "?", reason: c.labels.nylorun_egress_reason || "", count: c.value }))
      .sort((a, b) => b.count - a.count),
    egressBytes: [...counters(read, "nylorun_egress_bytes", ["network_io_direction"]).values()]
      .filter((c) => c.labels.network_io_direction)
      .map((c) => ({ direction: c.labels.network_io_direction!, bytes: c.value })),
    dropped: [...counters(read, "nylorun_telemetry_dropped", []).values()].reduce((n, c) => n + c.value, 0),
  };
}

/** `850 ms`, `3.2 s`, from seconds. */
export function formatSeconds(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
}
