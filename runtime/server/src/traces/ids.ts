/**
 * A turn's trace ids (R7.2, Q3): derived from the ids the log already holds, so every reader of
 * the log (the projector, a replay of its slot, the trace route) gives the same ids, and keyed
 * with the Tenant's trace key, so nobody computes them from a session id. Each is HMAC-SHA256
 * under the key, cut to 16 bytes (a trace id) or 8 (a span id), as lowercase hex.
 *
 * - **trace**: `trace|<tenant>|<session>|<turn>`, unless the turn arrived with a `traceparent`
 *   (R7.4): then that trace id.
 * - **turn span**: `span|turn|<turn>`; every crossing's span is its child.
 * - **effect span**: `span|effect|<effect id>`, for a model or tool call or a flow stage.
 * - **egress span**: `span|egress|<session>|<seq>`, for one `egress.connection` row.
 * - **event span**: `span|event|<session>|<seq>`, for a marker or a row without an effect id.
 */
import { createHmac } from "node:crypto";

/** The Tenant's trace key (`traces/key.ts`). */
export type TraceKey = Buffer;

function hmacHex(key: TraceKey, input: string, bytes: number): string {
  const hex = createHmac("sha256", key).update(input).digest().subarray(0, bytes).toString("hex");
  // An all-zero id is invalid in W3C trace context; one chance in 2^64 or worse.
  return /^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex;
}

export function traceIdOf(key: TraceKey, tenantId: string, sessionId: string, turnId: string): string {
  return hmacHex(key, `trace|${tenantId}|${sessionId}|${turnId}`, 16);
}

export function turnSpanOf(key: TraceKey, turnId: string): string {
  return hmacHex(key, `span|turn|${turnId}`, 8);
}

export function effectSpanOf(key: TraceKey, effectId: string): string {
  return hmacHex(key, `span|effect|${effectId}`, 8);
}

export function egressSpanOf(key: TraceKey, sessionId: string, seq: number): string {
  return hmacHex(key, `span|egress|${sessionId}|${seq}`, 8);
}

export function eventSpanOf(key: TraceKey, sessionId: string, seq: number): string {
  return hmacHex(key, `span|event|${sessionId}|${seq}`, 8);
}

/** W3C trace context (R7.4): `traceparent`, and `tracestate` when the caller sent one. */
export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/**
 * A `traceparent` as W3C trace context reads it: its trace id and parent span id, or undefined
 * when it is malformed (version `ff`, an all-zero id, or another shape), which a receiver
 * ignores. A version above `00` may carry more fields after the flags.
 */
export function parseTraceparent(value: string): { traceId: string; spanId: string } | undefined {
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return undefined;
  const [, version, traceId, spanId, , rest] = match;
  if (version === "ff" || (version === "00" && rest !== undefined)) return undefined;
  if (/^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return undefined;
  return { traceId: traceId!, spanId: spanId! };
}

/** The most `tracestate` the Runtime keeps (W3C: 32 members, 512 characters is enough). */
const TRACESTATE_MAX = 512;

/**
 * The trace context a request's headers carry (R7.4), or undefined without a valid
 * `traceparent`. A `tracestate` too long or with control characters is dropped, never the
 * `traceparent`. Kept normalized: `00-<trace>-<span>-<flags>`.
 */
export function traceContextOf(headers: {
  get(name: string): string | null | undefined;
}): TraceContext | undefined {
  const raw = headers.get("traceparent");
  if (!raw) return undefined;
  const parsed = parseTraceparent(raw);
  if (!parsed) return undefined;
  const flags = raw.trim().slice(53, 55);
  const traceparent = `00-${parsed.traceId}-${parsed.spanId}-${flags}`;
  const state = headers.get("tracestate")?.trim();
  return {
    traceparent,
    ...(state && state.length <= TRACESTATE_MAX && /^[\x20-\x7e]+$/.test(state) ? { tracestate: state } : {}),
  };
}

/** `00-<trace>-<span>-01`: the context a turn or a crossing hands on (sampled). */
export function traceparentOf(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
