/**
 * What a process's telemetry is configured with, parsed from the standard `OTEL_*` variables by
 * `host/stack-config.ts` (pure) and started by `setup.ts`.
 */

/** The `OTEL_TRACES_SAMPLER` values the Runtime honours (the OTel SDK environment specification). */
export const TRACE_SAMPLERS = [
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio",
] as const;
export type TraceSamplerName = (typeof TRACE_SAMPLERS)[number];

/** Where an OTLP/HTTP exporter posts, with `OTEL_EXPORTER_OTLP_HEADERS` and the signal's own. */
export interface OtlpTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface TelemetryConfig {
  /**
   * `service.name`: `nylorun-runtime` for core and loop, `nylorun-gateway` for the gates;
   * `OTEL_SERVICE_NAME`, then `OTEL_RESOURCE_ATTRIBUTES`' `service.name`, win. The other
   * `OTEL_RESOURCE_ATTRIBUTES` go on the resource as they are.
   */
  readonly resource: { readonly serviceName: string; readonly attributes: Readonly<Record<string, string>> };
  readonly metrics: {
    /**
     * `prometheus` in `OTEL_METRICS_EXPORTER` (the default): `/metrics` on
     * `OTEL_EXPORTER_PROMETHEUS_HOST`:`OTEL_EXPORTER_PROMETHEUS_PORT` (default `0.0.0.0:9464`;
     * a local Host's default host is `127.0.0.1`).
     */
    readonly prometheus?: { readonly host: string; readonly port: number };
    /**
     * `otlp` in `OTEL_METRICS_EXPORTER`, which it is by default when an OTLP endpoint is set:
     * `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, or the endpoint plus `/v1/metrics`.
     */
    readonly otlp?: OtlpTarget;
  };
  /** Live spans: only with an OTLP endpoint (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, or the endpoint plus `/v1/traces`). */
  readonly traces?: OtlpTarget & {
    /** `OTEL_TRACES_SAMPLER` (default `parentbased_always_on`) and its `_ARG`, a ratio (default 1). */
    readonly sampler: { readonly name: TraceSamplerName; readonly ratio: number };
  };
}

/** A setting that was read with a warning: logged once, at start, by `host/main.ts`. */
export interface SettingWarning {
  /** The log line's message, such as `trace_content_deprecated`. */
  readonly event: string;
  readonly variable: string;
  readonly message: string;
}
