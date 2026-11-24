/**
 * Telemetry for tests: a MeterProvider read in memory and, with `spans`, a
 * TracerProvider that keeps its spans in memory, made current with `useTelemetry` as
 * `host/main.ts` does with its own. `close()` goes back to the no-op.
 */
import { context, type Attributes } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  MeterProvider,
  MetricReader,
  type DataPoint,
  type Histogram,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { useTelemetry } from "../../src/telemetry/telemetry.js";

/** A reader the test collects from when it asks. */
export class TestReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

/** One metric point: its attributes, and its value (a sum) or its histogram. */
export interface Point {
  readonly attributes: Attributes;
  readonly value: number | Histogram;
}

export interface TestTelemetry {
  readonly reader: TestReader;
  /** The spans ended so far (with `spans`). */
  spans(): ReadableSpan[];
  /** The points of metric `name`, collected now. */
  points(name: string): Promise<Point[]>;
  /** Every metric collected now. */
  metrics(): Promise<MetricData[]>;
  close(): Promise<void>;
}

export function startTestTelemetry(options: { spans?: boolean } = {}): TestTelemetry {
  const reader = new TestReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  const exporter = new InMemorySpanExporter();
  let tracerProvider: BasicTracerProvider | undefined;
  let manager: AsyncLocalStorageContextManager | undefined;
  if (options.spans) {
    tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
  }
  useTelemetry({
    meter: meterProvider.getMeter("test"),
    ...(tracerProvider ? { tracer: tracerProvider.getTracer("test") } : {}),
  });
  const metrics = async () => (await reader.collect()).resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  return {
    reader,
    spans: () => exporter.getFinishedSpans(),
    metrics,
    async points(name) {
      const metric = (await metrics()).find((entry) => entry.descriptor.name === name);
      return (metric?.dataPoints ?? []).map((point: DataPoint<unknown>) => ({
        attributes: point.attributes,
        value: point.value as number | Histogram,
      }));
    },
    async close() {
      useTelemetry(undefined);
      await meterProvider.shutdown();
      await tracerProvider?.shutdown();
      if (manager) {
        context.disable();
        manager.disable();
      }
    },
  };
}

/** The count of a histogram point, or a sum's value. */
export function countOf(point: Point | undefined): number {
  if (point === undefined) return 0;
  return typeof point.value === "number" ? point.value : point.value.count;
}
