/**
 * Live telemetry for operators (ADR-159): the process's one Meter and, when spans export, one
 * Tracer, made with the OpenTelemetry API and SDK, with no automatic instrumentation. The Runtime
 * stores none of it: metrics live in the process's memory, served on `/metrics` and pushed over
 * OTLP; spans go over OTLP only.
 *
 * `host/main.ts` starts the providers (`setup.ts`) and hands them here with `useTelemetry`, as it
 * does the Host tuning; until then, and in every test that does not, the meter is a no-op and
 * there is no tracer, so a Host made by `createHost` binds no port and exports nothing. Code that
 * measures reads `instruments()` where it measures.
 *
 * Every metric attribute has a small fixed set of values: never a session, request, turn or
 * Tenant id, a host name or a person.
 */
import { createNoopMeter, type Attributes, type Counter, type Histogram, type Meter, type Tracer } from "@opentelemetry/api";

/** The process's telemetry: its meter, and its tracer when spans export. */
export interface Telemetry {
  readonly meter: Meter;
  /** Present only when spans export (`OTEL_EXPORTER_OTLP_ENDPOINT`): otherwise no span is made. */
  readonly tracer?: Tracer;
}

/** The instrumentation scope of every instrument and span the Runtime makes. */
export const SCOPE_NAME = "@nylorun/runtime";

const NOOP: Telemetry = { meter: createNoopMeter() };

let current: Telemetry = NOOP;
let made: Instruments | undefined;

/** The process's telemetry; a no-op meter and no tracer until `useTelemetry`. */
export function telemetry(): Telemetry {
  return current;
}

/** Sets the process's telemetry (`host/main.ts`, or a test); `undefined` goes back to the no-op. */
export function useTelemetry(next: Telemetry | undefined): void {
  current = next ?? NOOP;
  made = undefined;
}

/** Bucket boundaries (seconds) the HTTP semantic conventions advise for request durations. */
const HTTP_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
/** Bucket boundaries (seconds) the GenAI conventions advise for operation durations. */
const GENAI_SECONDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
/** Bucket boundaries (seconds) the MCP conventions advise for operation durations. */
const MCP_SECONDS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
/** A turn runs for minutes, waits included; a queued message waits as long. */
const LONG_SECONDS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200];

/** Every instrument the Runtime records, by name. */
export interface Instruments {
  /** `http.server.request.duration` (s): every Runtime API request (`telemetry/http.ts`). */
  readonly httpServerDuration: Histogram;
  /** `http.client.request.duration` (s): an HTTP tool's request (`gates/http-tool.ts`). */
  readonly httpClientDuration: Histogram;
  /** `gen_ai.client.inference.duration` (s): a model call the gate served (`gates/meter.ts`). */
  readonly inferenceDuration: Histogram;
  /** `gen_ai.client.inference.time_to_first_chunk` (s), when the adapter measured it. */
  readonly timeToFirstChunk: Histogram;
  /** `gen_ai.client.inference.usage.input_tokens` ({token}): a Counter at the pinned commit. */
  readonly inputTokens: Counter;
  /** `gen_ai.client.inference.usage.output_tokens` ({token}): a Counter at the pinned commit. */
  readonly outputTokens: Counter;
  /** `gen_ai.invoke_agent.duration` (s): a turn, from its start to its end, waits included. */
  readonly invokeAgentDuration: Histogram;
  /** `mcp.client.operation.duration` (s): a request the gate sent a remote MCP server. */
  readonly mcpDuration: Histogram;
  /** `nylorun.egress.connections` ({connection}): a sandbox's CONNECT, allowed or refused. */
  readonly egressConnections: Counter;
  /** `nylorun.egress.bytes` (By): what an allowed tunnel carried, each way. */
  readonly egressBytes: Counter;
  /** `nylorun.queue.wait` (s): how long a queued message waited until taken, failed or cancelled. */
  readonly queueWait: Histogram;
  /** `nylorun.telemetry.dropped` ({item}): spans or metric points an exporter failed to deliver. */
  readonly dropped: Counter;
}

/** The instruments on the current meter, made once per `useTelemetry`. */
export function instruments(): Instruments {
  return (made ??= makeInstruments(current.meter));
}

function makeInstruments(meter: Meter): Instruments {
  const seconds = (name: string, description: string, buckets: number[]) =>
    meter.createHistogram(name, { unit: "s", description, advice: { explicitBucketBoundaries: buckets } });
  return {
    httpServerDuration: seconds("http.server.request.duration", "Duration of HTTP server requests.", HTTP_SECONDS),
    httpClientDuration: seconds("http.client.request.duration", "Duration of HTTP client requests.", HTTP_SECONDS),
    inferenceDuration: seconds(
      "gen_ai.client.inference.duration",
      "GenAI client inference operation duration.",
      GENAI_SECONDS,
    ),
    timeToFirstChunk: seconds(
      "gen_ai.client.inference.time_to_first_chunk",
      "Time from the start of a logical inference operation to the first chunk in its streaming response.",
      GENAI_SECONDS,
    ),
    inputTokens: meter.createCounter("gen_ai.client.inference.usage.input_tokens", {
      unit: "{token}",
      description: "The number of input (prompt) tokens used, including cached tokens.",
    }),
    outputTokens: meter.createCounter("gen_ai.client.inference.usage.output_tokens", {
      unit: "{token}",
      description: "The number of output (completion) tokens used, including reasoning tokens.",
    }),
    invokeAgentDuration: seconds(
      "gen_ai.invoke_agent.duration",
      "The end-to-end duration of a turn, from its start to its end, waits for a person included.",
      LONG_SECONDS,
    ),
    mcpDuration: seconds(
      "mcp.client.operation.duration",
      "The duration of the MCP request or notification as observed on the sender from the time it was sent until the response or ack is received.",
      MCP_SECONDS,
    ),
    egressConnections: meter.createCounter("nylorun.egress.connections", {
      unit: "{connection}",
      description: "Connections a sandbox asked egress-gate for, by outcome and refusal reason.",
    }),
    egressBytes: meter.createCounter("nylorun.egress.bytes", {
      unit: "By",
      description: "Bytes an allowed egress tunnel carried, by direction.",
    }),
    queueWait: seconds(
      "nylorun.queue.wait",
      "How long a queued message waited, until a turn took it or it failed or was cancelled.",
      LONG_SECONDS,
    ),
    dropped: meter.createCounter("nylorun.telemetry.dropped", {
      unit: "{item}",
      description: "Spans or metric points an exporter failed to deliver, and dropped.",
    }),
  };
}

/** Seconds since `startedMs` (a `performance.now()` or `Date.now()` reading of the same clock). */
export function secondsSince(startedMs: number, nowMs: number): number {
  return Math.max(0, nowMs - startedMs) / 1000;
}

/** `attributes` without the absent ones, for a metric point. */
export function defined(attributes: Record<string, string | number | boolean | undefined>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined && value !== "") out[key] = value;
  return out;
}
