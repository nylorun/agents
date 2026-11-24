/**
 * The Runtime API's requests as telemetry: one HTTP server span
 * `{method} {http.route}` per request, when spans export, and one `http.server.request.duration`
 * point, by the HTTP semantic conventions. `http.route` is the declared pattern, never a path with
 * its ids: an unknown route is `other`. `nylorun.client` says which client sent it, from the
 * `Nylorun-Client` header (`studio`, `sdk`, `cli`), or from the route for A2A and AG-UI; anything
 * else is `other`.
 *
 * A request's span is the active span for everything it runs, so a command's turn becomes its
 * child (`requestTraceContext`) and log lines carry its ids. An incoming `traceparent` parents it.
 * Without span export nothing here makes a span, and a turn joins the caller's trace as before.
 */
import {
  context,
  createTraceState,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { parseTraceparent, traceContextOf, type TraceContext } from "../traces/ids.js";
import { telemetry } from "./telemetry.js";

/** The header a client names itself with. */
export const CLIENT_HEADER = "nylorun-client";

/** The values of `nylorun.client`. */
export const CLIENTS = ["studio", "sdk", "cli", "a2a", "ag-ui", "other"] as const;
export type ClientLabel = (typeof CLIENTS)[number];

/** `http.route` of a request no route matched. */
export const OTHER_ROUTE = "other";

const NAMED: ReadonlySet<string> = new Set(["studio", "sdk", "cli"]);

/** `nylorun.client`: A2A and AG-UI by their routes, else the header's value when it is known. */
export function clientOf(header: string | undefined, route: string): ClientLabel {
  if (route.startsWith("/v1/a2a/")) return "a2a";
  if (route.startsWith("/v1/ag-ui/")) return "ag-ui";
  const named = header?.trim().toLowerCase();
  return named !== undefined && NAMED.has(named) ? (named as ClientLabel) : "other";
}

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

/** `http.request.method`: a known method, else `_OTHER`. */
export function methodOf(method: string | undefined): string {
  const upper = (method ?? "").toUpperCase();
  return METHODS.has(upper) ? upper : "_OTHER";
}

/** What a request is labelled with, before it runs. */
export interface RequestLabels {
  readonly method: string;
  readonly route: string;
  readonly client: ClientLabel;
}

/**
 * Starts a request's server span when spans export, under the incoming `traceparent`. Returns
 * the context to run the request in, which holds the span (or none).
 */
export function startServerSpan(
  labels: RequestLabels,
  headers: { readonly traceparent?: string | undefined; readonly tracestate?: string | undefined },
): { readonly span?: Span; readonly context: Context } {
  const tracer = telemetry().tracer;
  if (!tracer) return { context: context.active() };
  const parent = remoteParent(headers.traceparent, headers.tracestate);
  const span = tracer.startSpan(
    labels.route === OTHER_ROUTE ? labels.method : `${labels.method} ${labels.route}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": labels.method,
        "url.scheme": "http",
        ...(labels.route === OTHER_ROUTE ? {} : { "http.route": labels.route }),
        "nylorun.client": labels.client,
      },
    },
    parent,
  );
  return { span, context: trace.setSpan(parent, span) };
}

/** Ends a request's span and records its `http.server.request.duration` point. */
export function endRequest(
  labels: RequestLabels,
  outcome: { readonly status: number; readonly seconds: number; readonly span?: Span | undefined },
  record: (seconds: number, attributes: Record<string, string | number>) => void,
): void {
  const failed = outcome.status >= 500;
  const attributes: Record<string, string | number> = {
    "http.request.method": labels.method,
    "http.route": labels.route,
    "http.response.status_code": outcome.status,
    "nylorun.client": labels.client,
    ...(failed ? { "error.type": String(outcome.status) } : {}),
  };
  record(outcome.seconds, attributes);
  const span = outcome.span;
  if (!span) return;
  span.setAttribute("http.response.status_code", outcome.status);
  if (failed) {
    span.setAttribute("error.type", String(outcome.status));
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

/** A remote parent from a valid `traceparent`; undefined for a malformed one. */
export function remoteContext(traceparent: string, tracestate?: string): Context | undefined {
  const parent = remoteParent(traceparent, tracestate);
  return parent === ROOT_CONTEXT ? undefined : parent;
}

/** The caller's span as a remote parent, from a valid `traceparent`; else the root context. */
function remoteParent(traceparent: string | undefined, tracestate: string | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return ROOT_CONTEXT;
  const flags = Number.parseInt(traceparent.trim().slice(53, 55), 16);
  const state = tracestate?.trim();
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: Number.isFinite(flags) ? flags & TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
    ...(state ? { traceState: createTraceState(state) } : {}),
  });
}

/**
 * The trace context a command's turn is recorded with: the request's server span when one
 * is recording, so the turn is its child, with the caller's `tracestate`; else the caller's own
 * `traceparent` (a malformed one is ignored), exactly as without telemetry.
 */
export function requestTraceContext(headers: { get(name: string): string | null | undefined }): TraceContext | undefined {
  const inbound = traceContextOf(headers);
  if (!telemetry().tracer) return inbound;
  const span = trace.getActiveSpan();
  const ids = span?.spanContext();
  if (!span || !ids || !span.isRecording() || !isSpanContextValid(ids)) return inbound;
  const flags = (ids.traceFlags & TraceFlags.SAMPLED).toString(16).padStart(2, "0");
  return {
    traceparent: `00-${ids.traceId}-${ids.spanId}-${flags}`,
    ...(inbound?.tracestate ? { tracestate: inbound.tracestate } : {}),
  };
}
