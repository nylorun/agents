/**
 * The Events tab's Trace view: a turn's spans (GET /v1/sessions/{id}/turns/{turnId}/trace, built
 * from the log on each read) as waterfall rows. Facts only: names, times, the model, tokens, the
 * tool, the status, and the log event each span came from (`nylorun.event.cursor`).
 */
import type { OtlpSpan, TurnTrace } from "@nylorun/agents";

/** One OTLP `AnyValue` as a plain value; a structured one (a list or a map) as JSON. */
export function attributeValue(value: Readonly<Record<string, unknown>>): string | number | boolean | undefined {
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.arrayValue !== undefined || value.kvlistValue !== undefined)
    return JSON.stringify(value.arrayValue ?? value.kvlistValue);
  return undefined;
}

export function attributesOf(span: Pick<OtlpSpan, "attributes">): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const { key, value } of span.attributes) {
    const plain = attributeValue(value);
    if (plain !== undefined) out[key] = plain;
  }
  return out;
}

export interface TraceRow {
  spanId: string;
  name: string;
  /** `invoke_agent`, `chat`, `execute_tool`, or none for a marker. */
  operation?: string;
  /** How deep in the tree: the turn is 0. */
  depth: number;
  /** From the trace's first span's start, in milliseconds. */
  offsetMs: number;
  durationMs: number;
  error: boolean;
  /** The status message, when content capture lets errors through. */
  errorMessage?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  tool?: string;
  /** The log event the span came from: Open event finds it by this cursor. */
  cursor?: string;
  attributes: Record<string, string | number | boolean>;
}

const ms = (nanos: string) => Number(BigInt(nanos) / 1_000_000n);

/** A trace's spans, in tree order (each parent before its children, siblings by start). */
export function traceRows(trace: TurnTrace): TraceRow[] {
  const spans = trace.resourceSpans.flatMap((r) => r.scopeSpans).flatMap((s) => s.spans);
  if (spans.length === 0) return [];
  const origin = Math.min(...spans.map((s) => ms(s.startTimeUnixNano)));
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string, OtlpSpan[]>();
  const roots: OtlpSpan[] = [];
  for (const span of spans) {
    if (span.parentSpanId && ids.has(span.parentSpanId)) {
      const list = children.get(span.parentSpanId) ?? [];
      list.push(span);
      children.set(span.parentSpanId, list);
    } else roots.push(span);
  }
  const byStart = (a: OtlpSpan, b: OtlpSpan) => ms(a.startTimeUnixNano) - ms(b.startTimeUnixNano);
  const rows: TraceRow[] = [];
  const visit = (span: OtlpSpan, depth: number) => {
    const a = attributesOf(span);
    const start = ms(span.startTimeUnixNano);
    const num = (key: string) => (typeof a[key] === "number" ? (a[key] as number) : undefined);
    const str = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : undefined);
    rows.push({
      spanId: span.spanId,
      name: span.name,
      operation: str("gen_ai.operation.name"),
      depth,
      offsetMs: start - origin,
      durationMs: Math.max(0, ms(span.endTimeUnixNano) - start),
      error: span.status.code === 2,
      errorMessage: span.status.message,
      model: str("gen_ai.response.model") ?? str("gen_ai.request.model"),
      inputTokens: num("gen_ai.usage.input_tokens"),
      outputTokens: num("gen_ai.usage.output_tokens"),
      tool: str("gen_ai.tool.name"),
      cursor: str("nylorun.event.cursor"),
      attributes: a,
    });
    for (const child of (children.get(span.spanId) ?? []).sort(byStart)) visit(child, depth + 1);
  };
  for (const root of roots.sort(byStart)) visit(root, 0);
  return rows;
}

/** The trace's length: from its first start to its last end. */
export function traceLengthMs(rows: readonly TraceRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.offsetMs + row.durationMs), 0);
}

/** The session's turns that have events, oldest first. */
export function turnIdsOf(events: readonly { turnId?: string | null }[]): string[] {
  const out: string[] = [];
  for (const { turnId } of events) if (turnId && !out.includes(turnId)) out.push(turnId);
  return out;
}

/** `850 ms`, `3.2 s`, `2 min 5 s`. */
export function formatSpanTime(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes} min ${Math.round((milliseconds % 60_000) / 1000)} s`;
}
