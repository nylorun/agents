/**
 * The trace route's spans (R7.5): a turn's log rows mapped by the same `spanOf` the projector
 * posts with, under the installation's resource and content opt-ins, so the route and the
 * exporter agree span for span.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import type { TenantContext } from "../tenant/context.js";
import { traceKey } from "./key.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import { spanOf, turnTraceOf, type OtlpSpan } from "./map.js";
import { DEFAULT_SERVICE_NAME, resourceSpans } from "./otlp.js";

/** Turn `turnId`'s spans as an OTLP `ExportTraceServiceRequest`, from its rows in log order. */
export async function turnTrace(ctx: TenantContext, sessionId: string, turnId: string, events: readonly LiveEvent[]) {
  const settings = {
    key: await traceKey(ctx.store),
    content: ctx.traces?.content ?? new Set(),
    contentBytes: (await ctx.store.tx((t) => readRuntimeLimits(t))).traceContentBytes,
  };
  const message = events.find((event) => event.type === "command.message");
  const turn = turnTraceOf(settings, { tenantId: ctx.store.tenantId, sessionId, turnId }, message);
  const spans: OtlpSpan[] = [];
  for (const event of events) {
    const span = spanOf(event, turn, settings);
    if (span) spans.push(span);
  }
  return resourceSpans(ctx.traces?.resource ?? { serviceName: DEFAULT_SERVICE_NAME }, spans);
}
