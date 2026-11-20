/**
 * Studio's Tenant › Traffic (ADR-159): the Runtime's own metrics, read live from each process's
 * `/metrics` (OpenTelemetry's Prometheus exporter, in memory since the process started). Studio
 * stores none of it and emits none of its own.
 */

/** One metrics source: a name the page shows (`runtime`, `gateway`) and its `/metrics` URL. */
export type MetricsSource = Readonly<{ name: string; url: string }>;

/** One sample of the Prometheus text format: `name{label="value",…} value`. */
export type MetricSample = Readonly<{ name: string; labels: Readonly<Record<string, string>>; value: number }>;

export type MetricsRead = Readonly<{
  /** When the reads were made (ISO). */
  at: string;
  sources: readonly Readonly<{ name: string; ok: boolean; error?: string; samples: readonly MetricSample[] }>[];
}>;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Validates `NYLORUN_STUDIO_METRICS_URLS`: empty (Traffic is off) or `name=url` pairs separated by
 * commas, such as `runtime=http://runtime:9464/metrics,gateway=http://gateway:9464/metrics`.
 */
export function parseMetricsSources(value: string): MetricsSource[] {
  const out: MetricsSource[] = [];
  for (const part of value.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const at = entry.indexOf("=");
    const name = at > 0 ? entry.slice(0, at) : "";
    const raw = at > 0 ? entry.slice(at + 1) : "";
    if (!NAME.test(name)) throw new Error(`${entry} is not name=url: a lowercase name, then the /metrics URL.`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${raw} is not a URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${raw} is not an http(s) URL.`);
    if (out.some((s) => s.name === name)) throw new Error(`${name} is named twice.`);
    out.push({ name, url: url.toString() });
  }
  return out;
}

/** The families Traffic shows; anything else a process serves is left out. */
const KEPT = /^(http_server_request_duration|http_client_request_duration|gen_ai_|mcp_client_operation_duration|nylorun_)/;

function unescape(value: string): string {
  return value.replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c));
}

/** Parses the Prometheus text exposition format: samples only, comments and types skipped. */
export function parsePrometheus(text: string, keep: RegExp = KEPT): MetricSample[] {
  const out: MetricSample[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(?:\s+\d+)?$/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!;
    if (!keep.test(name)) continue;
    const labels: Record<string, string> = {};
    const body = match[3] ?? "";
    const pair = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"\s*,?/g;
    for (let m = pair.exec(body); m; m = pair.exec(body)) labels[m[1]!] = unescape(m[2]!);
    const raw = match[4]!;
    const value = raw === "+Inf" ? Infinity : raw === "-Inf" ? -Infinity : Number(raw);
    if (Number.isNaN(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

/** Reads every source once, each within `timeoutMs`; a source that fails says why. */
export async function readMetrics(
  sources: readonly MetricsSource[],
  options: Readonly<{ timeoutMs?: number; fetcher?: typeof fetch; now?: () => Date }> = {},
): Promise<MetricsRead> {
  const fetcher = options.fetcher ?? fetch;
  const at = (options.now ?? (() => new Date()))().toISOString();
  const read = await Promise.all(
    sources.map(async ({ name, url }) => {
      try {
        const response = await fetcher(url, {
          headers: { accept: "text/plain" },
          signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
        });
        if (!response.ok) return { name, ok: false, error: `HTTP ${response.status}`, samples: [] };
        return { name, ok: true, samples: parsePrometheus(await response.text()) };
      } catch (cause) {
        return { name, ok: false, error: cause instanceof Error ? cause.message : String(cause), samples: [] };
      }
    }),
  );
  return { at, sources: read };
}
