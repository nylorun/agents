/**
 * The process's telemetry as `host/main.ts` starts it (ADR-159): `/metrics` served in Prometheus
 * format, OTLP exports that fail dropped and counted, the samplers, and a port that cannot be
 * bound logged rather than fatal.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { SamplingDecision, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  countingMetricExporter,
  countingSpanExporter,
  samplerOf,
  startTelemetry,
  type StartedTelemetry,
} from "../../src/telemetry/setup.js";
import { instruments, telemetry } from "../../src/telemetry/telemetry.js";
import type { TelemetryConfig } from "../../src/telemetry/config.js";
import { countOf, startTestTelemetry } from "../support/telemetry.js";

const lines: { message: string; fields?: Record<string, unknown> }[] = [];
const logger = {
  info: (message: string, fields?: Record<string, unknown>) => lines.push({ message, ...(fields ? { fields } : {}) }),
  warn: (message: string, fields?: Record<string, unknown>) => lines.push({ message, ...(fields ? { fields } : {}) }),
  error: (message: string, fields?: Record<string, unknown>) => lines.push({ message, ...(fields ? { fields } : {}) }),
};

const config = (overrides: Partial<TelemetryConfig> = {}): TelemetryConfig => ({
  resource: { serviceName: "nylorun-runtime", attributes: { "deployment.environment": "test" } },
  metrics: { prometheus: { host: "127.0.0.1", port: 0 } },
  ...overrides,
});

const started: StartedTelemetry[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const one of started.splice(0)) await one.shutdown();
  for (const close of closers.splice(0)) await close();
  lines.length = 0;
});

describe("startTelemetry", () => {
  it("serves every instrument on /metrics in Prometheus format, with the resource", async () => {
    const running = await startTelemetry(config(), { logger });
    started.push(running);
    expect(running.metricsUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
    expect(telemetry()).toBe(running.telemetry);
    // Without an endpoint there is no tracer: nothing makes a span.
    expect(running.telemetry.tracer).toBeUndefined();
    const meters = instruments();
    const route = { "http.request.method": "POST", "http.route": "/v1/sessions/{sessionId}/commands", "http.response.status_code": 200, "nylorun.client": "sdk" };
    meters.httpServerDuration.record(0.12, route);
    const model = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "anthropic/claude" };
    meters.inferenceDuration.record(2.5, model);
    meters.timeToFirstChunk.record(0.4, model);
    meters.inputTokens.add(1200, model);
    meters.outputTokens.add(80, model);
    meters.invokeAgentDuration.record(12, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "coder" });
    meters.mcpDuration.record(0.3, { "mcp.method.name": "tools/call", "gen_ai.tool.name": "search" });
    meters.httpClientDuration.record(0.2, { "http.request.method": "POST", "http.response.status_code": 200 });
    meters.egressConnections.add(1, { "nylorun.egress.outcome": "refused", "nylorun.egress.reason": "host_not_allowed" });
    meters.egressBytes.add(512, { "network.io.direction": "receive" });
    meters.queueWait.record(1.5, { "nylorun.queue.outcome": "taken" });
    meters.dropped.add(3, { signal: "traces", exporter: "otlp" });

    const response = await fetch(running.metricsUrl!);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    const text = await response.text();
    // Prometheus names (exporter-prometheus 0.223): dots to underscores, `_total` on counters, no
    // unit suffix; every point carries its scope, and the resource is on `target_info`.
    const scope = 'otel_scope_name="@nylorun/runtime"';
    for (const family of [
      "# TYPE http_server_request_duration histogram",
      "# UNIT http_server_request_duration s",
      `http_server_request_duration_count{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="200",nylorun_client="sdk",${scope}`,
      "# TYPE gen_ai_client_inference_duration histogram",
      "# TYPE gen_ai_client_inference_time_to_first_chunk histogram",
      `gen_ai_client_inference_usage_input_tokens_total{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="anthropic/claude",${scope}`,
      "# TYPE gen_ai_client_inference_usage_output_tokens_total counter",
      "# TYPE gen_ai_invoke_agent_duration histogram",
      "# TYPE mcp_client_operation_duration histogram",
      "# TYPE http_client_request_duration histogram",
      `nylorun_egress_connections_total{nylorun_egress_outcome="refused",nylorun_egress_reason="host_not_allowed",${scope}`,
      `nylorun_egress_bytes_total{network_io_direction="receive",${scope}`,
      "# TYPE nylorun_queue_wait histogram",
      `nylorun_telemetry_dropped_total{signal="traces",exporter="otlp",${scope}`,
      'target_info{deployment_environment="test",service_name="nylorun-runtime",service_version=',
    ])
      expect(text).toContain(family);
    // The GenAI conventions' buckets.
    expect(text).toMatch(/gen_ai_client_inference_duration_bucket\{[^}]*le="0\.01"\} 0/);
    expect(text).toMatch(/gen_ai_client_inference_duration_bucket\{[^}]*le="81\.92"\} 1/);
    expect((await fetch(running.metricsUrl!.replace("/metrics", "/other"))).status).toBe(404);
    expect(lines.map((line) => line.message)).toContain("metrics_ready");
  });

  it("logs a /metrics port it cannot bind, and runs without it", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => taken.close(() => resolve())));
    const port = (taken.address() as AddressInfo).port;
    const running = await startTelemetry(config({ metrics: { prometheus: { host: "127.0.0.1", port } } }), { logger });
    started.push(running);
    expect(running.metricsUrl).toBeUndefined();
    expect(lines).toContainEqual(expect.objectContaining({ message: "metrics_listen_failed", fields: expect.objectContaining({ port }) }));
    instruments().queueWait.record(1, { "nylorun.queue.outcome": "taken" });
  });

  it("makes spans only with an OTLP endpoint, and goes back to the no-op on shutdown", async () => {
    const exported: unknown[] = [];
    const running = await startTelemetry(
      config({
        metrics: {},
        traces: { url: "http://127.0.0.1:1/v1/traces", headers: {}, sampler: { name: "always_on", ratio: 1 } },
      }),
      {
        logger,
        spanExporter: { export: (spans, done) => (exported.push(...spans), done({ code: 0 })), shutdown: async () => {} },
      },
    );
    const tracer = running.telemetry.tracer!;
    const span = tracer.startSpan("GET /health");
    span.end();
    await running.shutdown();
    expect(exported).toHaveLength(1);
    expect(telemetry().tracer).toBeUndefined();
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});

describe("an exporter that fails", () => {
  it("drops the metric points and counts them, and warns once a minute", async () => {
    const test = startTestTelemetry();
    closers.push(() => test.close());
    instruments().queueWait.record(1, { "nylorun.queue.outcome": "taken" });
    const { resourceMetrics } = await test.reader.collect();
    const failing: PushMetricExporter = {
      export: (_metrics, done) => done({ code: 1, error: new Error("connect ECONNREFUSED") }),
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const warnings: string[] = [];
    const counted = countingMetricExporter(failing, (signal, items, reason) => warnings.push(`${signal} ${items} ${reason}`));
    const results: number[] = [];
    counted.export(resourceMetrics, (result) => results.push(result.code));
    expect(results).toEqual([1]);
    expect(await test.points("nylorun.telemetry.dropped")).toEqual([
      { attributes: { signal: "metrics", exporter: "otlp" }, value: 1 },
    ]);
    expect(warnings).toEqual(["metrics 1 connect ECONNREFUSED"]);
  });

  it("drops the spans and counts them; a success counts nothing", async () => {
    const test = startTestTelemetry();
    closers.push(() => test.close());
    let code = 1;
    const exporter: SpanExporter = { export: (_spans, done) => done({ code }), shutdown: async () => {} };
    const counted = countingSpanExporter(exporter);
    const spans = [{}, {}, {}] as unknown as Parameters<SpanExporter["export"]>[0];
    counted.export(spans, () => {});
    code = 0;
    counted.export(spans, () => {});
    expect(countOf((await test.points("nylorun.telemetry.dropped"))[0])).toBe(3);
  });

  it("never holds up the process: a collector that is down only counts", async () => {
    const running = await startTelemetry(
      config({ metrics: { otlp: { url: "http://127.0.0.1:1/v1/metrics", headers: {} } } }),
      { logger, exportIntervalMs: 100 },
    );
    started.push(running);
    instruments().queueWait.record(1, { "nylorun.queue.outcome": "taken" });
    await expect.poll(() => lines.some((line) => line.message === "telemetry_export_dropped"), { timeout: 10_000 }).toBe(true);
    expect(lines.find((line) => line.message === "telemetry_export_dropped")!.fields).toMatchObject({
      signal: "metrics",
      exporter: "otlp",
    });
  });
});

describe("samplerOf", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const decide = (name: Parameters<typeof samplerOf>[0]["name"], ratio = 1) =>
    samplerOf({ name, ratio }).shouldSample(ROOT_CONTEXT, traceId, "GET /health", SpanKind.SERVER, {}, []).decision;
  it.each([
    ["always_on", 1, SamplingDecision.RECORD_AND_SAMPLED],
    ["always_off", 1, SamplingDecision.NOT_RECORD],
    ["traceidratio", 0, SamplingDecision.NOT_RECORD],
    ["traceidratio", 1, SamplingDecision.RECORD_AND_SAMPLED],
    ["parentbased_always_on", 1, SamplingDecision.RECORD_AND_SAMPLED],
    ["parentbased_always_off", 1, SamplingDecision.NOT_RECORD],
    ["parentbased_traceidratio", 0, SamplingDecision.NOT_RECORD],
  ] as const)("samples a root span by %s (ratio %d)", (name, ratio, decision) => {
    expect(decide(name, ratio)).toBe(decision);
  });
});
