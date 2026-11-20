import { context, isSpanContextValid, trace } from "@opentelemetry/api";
import type { Logger } from "../tenant/types.js";

/**
 * Host logger: JSON lines to stdout (CLI redirects to `runtime.log`). A line written while a span
 * is active (with span export, the request's server span, ADR-159) carries its `trace_id` and
 * `span_id`, so a log line joins its trace.
 */
export function createHostLogger(
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Logger {
  const emit = (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    const span = trace.getSpanContext(context.active());
    write(
      JSON.stringify({
        level,
        message,
        time: new Date().toISOString(),
        ...(span && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : {}),
        ...fields,
      }),
    );
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
