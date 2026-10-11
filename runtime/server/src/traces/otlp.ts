/**
 * OTLP/HTTP JSON (R7.2): the encoder of a batch of spans as `resourceSpans`, and the poster that
 * delivers one to the collector's `/v1/traces`. Hand-built JSON, no OpenTelemetry SDK: the spans
 * are mapped from records (`map.ts`), not timed from live code.
 *
 * Delivery never holds the log back: a `429`, a `5xx` or a lost connection is tried again three
 * times with backoff, then the batch is dropped and logged (`trace_export_dropped`); any other
 * answer drops it at once. Either way `post` resolves, and the projector acknowledges the rows,
 * so a dead collector makes Postgres keep no WAL. The trace route (R7.5) re-reads any turn.
 */
import { RUNTIME_VERSION } from "../version.js";
import { GENAI_SEMCONV, type OtlpKeyValue, type OtlpSpan } from "./map.js";

/** What every batch says about its source: `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`. */
export interface TraceResource {
  /** `service.name`; default `nylorun`. */
  readonly serviceName: string;
  /** More resource attributes, as `OTEL_RESOURCE_ATTRIBUTES` sets them. */
  readonly attributes?: Readonly<Record<string, string>>;
}

export const DEFAULT_SERVICE_NAME = "nylorun";

/** The instrumentation scope of every span. */
const SCOPE = { name: "@nylorun/runtime", version: RUNTIME_VERSION };

/** A batch of spans as an OTLP `ExportTraceServiceRequest` in JSON. */
export function resourceSpans(resource: TraceResource, spans: readonly OtlpSpan[]) {
  const attributes: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(resource.attributes ?? {}))
    if (key !== "service.name") attributes.push({ key, value: { stringValue: value } });
  attributes.unshift({ key: "service.name", value: { stringValue: resource.serviceName } });
  attributes.push({ key: "nylorun.semconv.genai", value: { stringValue: GENAI_SEMCONV } });
  return {
    resourceSpans: [{ resource: { attributes }, scopeSpans: [{ scope: SCOPE, spans: [...spans] }] }],
  };
}

export interface OtlpPosterOptions {
  /** The traces URL: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, or the endpoint plus `/v1/traces`. */
  readonly url: string;
  /** `OTEL_EXPORTER_OTLP_HEADERS`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly resource: TraceResource;
  /** Tries after the first, for a `429`, a `5xx` or a lost connection. Default 3. */
  readonly retries?: number;
  /** The wait before the first retry, doubled for each one after. Default 500 ms. */
  readonly backoffMs?: number;
  /** How long one request may take. Default 10 s. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Posts one batch; resolves `posted` or `dropped`, never rejects. */
export type OtlpPoster = (spans: readonly OtlpSpan[], signal?: AbortSignal) => Promise<"posted" | "dropped">;

export function createOtlpPoster(options: OtlpPosterOptions): OtlpPoster {
  const send = options.fetch ?? fetch;
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.log ?? (() => {});
  return async (spans, signal) => {
    if (spans.length === 0) return "posted";
    const body = JSON.stringify(resourceSpans(options.resource, spans));
    let reason = "";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0 && !(await pause(backoffMs * 2 ** (attempt - 1), signal))) break;
      let status: number;
      try {
        const response = await send(options.url, {
          method: "POST",
          headers: { ...options.headers, "content-type": "application/json" },
          body,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        if (signal?.aborted) break;
        continue;
      }
      if (status >= 200 && status < 300) return "posted";
      reason = `HTTP ${status}`;
      if (status !== 429 && status < 500) break;
    }
    log("trace_export_dropped", { spans: spans.length, reason });
    return "dropped";
  };
}

/** Waits `ms`; false when `signal` aborted first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
