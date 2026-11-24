/**
 * Starts a process's telemetry: one MeterProvider and, when spans export, one
 * TracerProvider, from the settings `host/stack-config.ts` parsed. Only `host/main.ts` calls it,
 * so a Host a test makes with `createHost` binds no port.
 *
 * - **Metrics** are read by Prometheus on `/metrics` (`OTEL_METRICS_EXPORTER=prometheus`, the
 *   default) and pushed over OTLP/HTTP every minute (`otlp`, the default when an endpoint is set).
 * - **Spans** are made only with an OTLP endpoint, batched and posted over OTLP/HTTP, sampled by
 *   `OTEL_TRACES_SAMPLER`. Without one there is no tracer, and nothing is made.
 * - **Context**: with spans, the AsyncLocalStorage context manager is registered, so the request's
 *   span is the active one in everything it runs, and the Host logger stamps its ids.
 *
 * Telemetry fails open: an export that fails is dropped and counted on `nylorun.telemetry.dropped`
 * (`signal`, `exporter`), with a warning at most once a minute per signal, and nothing waits on an
 * exporter. A `/metrics` port that cannot be bound is logged, and the process runs without it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { GENAI_SEMCONV } from "../traces/map.js";
import type { Logger } from "../tenant/types.js";
import { RUNTIME_VERSION } from "../version.js";
import type { TelemetryConfig } from "./config.js";
import { instruments, SCOPE_NAME, useTelemetry, type Telemetry } from "./telemetry.js";

/** The path Prometheus scrapes. */
export const METRICS_PATH = "/metrics";

export interface StartedTelemetry {
  readonly telemetry: Telemetry;
  /** The `/metrics` URL when Prometheus serves it. */
  readonly metricsUrl?: string;
  /** Flushes what waits (bounded by the exporters' timeouts) and closes `/metrics`. Never rejects. */
  shutdown(): Promise<void>;
}

export interface StartTelemetryOptions {
  readonly logger: Logger;
  /** Tests add a reader, such as one in memory. */
  readonly readers?: readonly MetricReader[];
  /** Tests replace the OTLP exporters. */
  readonly metricExporter?: PushMetricExporter;
  readonly spanExporter?: SpanExporter;
  /** How often OTLP metrics are pushed. Default 60 s (the SDK's). */
  readonly exportIntervalMs?: number;
}

/**
 * Starts the process's telemetry and makes it current (`useTelemetry`). Resolves once `/metrics`
 * listens or failed to.
 */
export async function startTelemetry(config: TelemetryConfig, options: StartTelemetryOptions): Promise<StartedTelemetry> {
  const { logger } = options;
  const resource = resourceFromAttributes({
    ...config.resource.attributes,
    "service.name": config.resource.serviceName,
    "service.version": RUNTIME_VERSION,
    "nylorun.semconv.genai": GENAI_SEMCONV,
  });
  const warn = warnOncePerMinute(logger);
  const readers: MetricReader[] = [...(options.readers ?? [])];
  let prometheus: PrometheusExporter | undefined;
  if (config.metrics.prometheus) {
    prometheus = new PrometheusExporter({ preventServerStart: true });
    readers.push(prometheus);
  }
  const otlpMetrics =
    options.metricExporter ??
    (config.metrics.otlp
      ? new OTLPMetricExporter({ url: config.metrics.otlp.url, headers: { ...config.metrics.otlp.headers } })
      : undefined);
  if (otlpMetrics)
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: countingMetricExporter(otlpMetrics, warn),
        ...(options.exportIntervalMs ? { exportIntervalMillis: options.exportIntervalMs } : {}),
      }),
    );
  const meterProvider = new MeterProvider({ resource, readers });

  let tracerProvider: BasicTracerProvider | undefined;
  let contextManager: AsyncLocalStorageContextManager | undefined;
  const spanExporter =
    options.spanExporter ??
    (config.traces ? new OTLPTraceExporter({ url: config.traces.url, headers: { ...config.traces.headers } }) : undefined);
  if (config.traces && spanExporter) {
    tracerProvider = new BasicTracerProvider({
      resource,
      sampler: samplerOf(config.traces.sampler),
      spanProcessors: [new BatchSpanProcessor(countingSpanExporter(spanExporter, warn))],
    });
    contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
  }

  const started: Telemetry = {
    meter: meterProvider.getMeter(SCOPE_NAME, RUNTIME_VERSION),
    ...(tracerProvider ? { tracer: tracerProvider.getTracer(SCOPE_NAME, RUNTIME_VERSION) } : {}),
  };
  useTelemetry(started);

  let server: Server | undefined;
  let metricsUrl: string | undefined;
  if (prometheus && config.metrics.prometheus) {
    const { host, port } = config.metrics.prometheus;
    const exporter = prometheus;
    const listening = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://metrics.local").pathname;
      if (request.method === "GET" && path === METRICS_PATH) exporter.getMetricsRequestHandler(request, response);
      else response.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(port, host, () => {
          listening.off("error", reject);
          resolve();
        });
      });
      server = listening;
      const bound = listening.address() as AddressInfo;
      metricsUrl = `http://${bound.family === "IPv6" ? `[${bound.address}]` : bound.address}:${bound.port}${METRICS_PATH}`;
      logger.info("metrics_ready", { url: metricsUrl });
    } catch (error) {
      logger.warn("metrics_listen_failed", {
        host,
        port,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    telemetry: started,
    ...(metricsUrl ? { metricsUrl } : {}),
    async shutdown() {
      await Promise.allSettled([
        meterProvider.shutdown(),
        tracerProvider?.shutdown(),
        server ? new Promise<void>((resolve) => server!.close(() => resolve())) : undefined,
      ]);
      server?.closeAllConnections();
      if (contextManager) {
        context.disable();
        contextManager.disable();
      }
      useTelemetry(undefined);
    },
  };
}

/** The sampler `OTEL_TRACES_SAMPLER` and `_ARG` name. */
export function samplerOf(sampler: NonNullable<TelemetryConfig["traces"]>["sampler"]): Sampler {
  const ratio = () => new TraceIdRatioBasedSampler(sampler.ratio);
  switch (sampler.name) {
    case "always_on":
      return new AlwaysOnSampler();
    case "always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
      return ratio();
    case "parentbased_always_off":
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "parentbased_traceidratio":
      return new ParentBasedSampler({ root: ratio() });
    case "parentbased_always_on":
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

type Warn = (signal: "metrics" | "traces", items: number, reason: string) => void;

/** A warning per signal at most once a minute: a collector that is down is said, not shouted. */
function warnOncePerMinute(logger: Logger): Warn {
  const last = new Map<string, number>();
  return (signal, items, reason) => {
    const now = Date.now();
    if (now - (last.get(signal) ?? -Infinity) < 60_000) return;
    last.set(signal, now);
    logger.warn("telemetry_export_dropped", { signal, exporter: "otlp", items, reason });
  };
}

/** How the SDK says an export ended: `code` 0 is success (`ExportResultCode`). */
type ExportResult = { code: number; error?: Error };

const reasonOf = (result: ExportResult) => result.error?.message ?? "export failed";

/** `exporter`, counting the points of each failed export on `nylorun.telemetry.dropped`. */
export function countingMetricExporter(exporter: PushMetricExporter, warn: Warn = () => {}): PushMetricExporter {
  const counted: PushMetricExporter = {
    export(metrics, done) {
      exporter.export(metrics, (result: ExportResult) => {
        if (result.code !== 0) {
          const points = pointsOf(metrics);
          instruments().dropped.add(points, { signal: "metrics", exporter: "otlp" });
          warn("metrics", points, reasonOf(result));
        }
        done(result as Parameters<typeof done>[0]);
      });
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
  };
  if (exporter.selectAggregationTemporality)
    counted.selectAggregationTemporality = (type) => exporter.selectAggregationTemporality!(type);
  if (exporter.selectAggregation) counted.selectAggregation = (type) => exporter.selectAggregation!(type);
  return counted;
}

/** `exporter`, counting the spans of each failed export on `nylorun.telemetry.dropped`. */
export function countingSpanExporter(exporter: SpanExporter, warn: Warn = () => {}): SpanExporter {
  return {
    export(spans, done) {
      exporter.export(spans, (result: ExportResult) => {
        if (result.code !== 0) {
          instruments().dropped.add(spans.length, { signal: "traces", exporter: "otlp" });
          warn("traces", spans.length, reasonOf(result));
        }
        done(result as Parameters<typeof done>[0]);
      });
    },
    shutdown: () => exporter.shutdown(),
    ...(exporter.forceFlush ? { forceFlush: () => exporter.forceFlush!() } : {}),
  };
}

function pointsOf(metrics: ResourceMetrics): number {
  let points = 0;
  for (const scope of metrics.scopeMetrics) for (const metric of scope.metrics) points += metric.dataPoints.length;
  return points;
}
