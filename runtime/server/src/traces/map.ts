/**
 * Row to span (R7.2): a pure function from one committed session event and its turn's trace to
 * at most one OTLP span, so the projector, a replay of its slot and the trace route (R7.5) give
 * the same spans. Nothing outside the row and the turn is read.
 *
 * | Row | Span |
 * | --- | --- |
 * | `turn.completed`, `turn.failed`, `turn.cancelled` | `invoke_agent {manifest name}`, the turn's root (INTERNAL) |
 * | `message.assistant`, `model.failed`, `context.compacted` | `chat {model}` (CLIENT) |
 * | `tool.completed` | `execute_tool {toolName}` (INTERNAL) |
 * | `node.completed` | `execute_tool {key}`, a flow's HTTP stage (INTERNAL) |
 * | `effect.uncertain` | the call's span, with an error status |
 * | `turn.paused`, `command.approve`, `command.respond` | a marker with no length |
 *
 * Every other row, and every row without a turn, makes none. Every child's parent is the turn's
 * span, so a child exported before its turn ends still joins it.
 *
 * Timing: a span with a gate's own measurement (`gate`, R7.1) is that measurement; any other ends
 * at the row's time and starts `durationMs` before it (the journal's window, exported as
 * `nylorun.effect.window_ms`). Egress has no span: a connection is the Environment's, not a
 * turn's (D67), and is read from the Environment's events.
 *
 * Attribute names follow the OTel GenAI conventions at `GENAI_SEMCONV` (still in Development
 * status), recorded on the resource as `nylorun.semconv.genai`; the rest are `nylorun.*`. A span
 * never carries a person's id (`ownerUserId`, a subject, who approved), an identity header, an
 * idempotency key or a credential value (the log holds none). Content (what a person said, the
 * model's output, tool results and error messages) is left out unless the installation opts in
 * per kind (`TraceContent`), each value cut at the Tenant's Runtime limit `traceContentBytes`
 * (`SpanSettings.contentBytes`). Prompts are not in the log, so never here.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import { effectSpanOf, eventSpanOf, parseTraceparent, traceIdOf, turnSpanOf, type TraceKey } from "./ids.js";

/** The commit of open-telemetry/semantic-conventions-genai whose attribute names spans use. */
export const GENAI_SEMCONV = "open-telemetry/semantic-conventions-genai@6fd0d763a092db245a54104fc1124031eb3c51d2";

/**
 * The content an installation exports (Q4): `user` (what a person sent, on the turn's span),
 * `outputs` (the model's text and tool calls, and a turn's output), `tool-results` and `errors`
 * (error messages; their codes are always exported).
 */
export const TRACE_CONTENT_KINDS = ["user", "outputs", "tool-results", "errors"] as const;
export type TraceContentKind = (typeof TRACE_CONTENT_KINDS)[number];
export type TraceContent = ReadonlySet<TraceContentKind>;

/** OTLP span kinds and status codes (opentelemetry-proto `trace.proto`). */
export const SPAN_KIND = { internal: 1, client: 3 } as const;
export const STATUS = { unset: 0, ok: 1, error: 2 } as const;

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
}
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}
/** One span as OTLP/HTTP JSON encodes it: hex ids, times as decimal nanosecond strings. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

/**
 * A turn's trace: its trace id, its span, and the context it arrived with (R7.4). Built from the
 * turn's `command.message` (`turnTraceOf`), so it is the same wherever the log is read.
 */
export interface TurnTrace {
  readonly traceId: string;
  readonly spanId: string;
  /** The span of the caller that sent the turn's message with a `traceparent`. */
  readonly parentSpanId?: string;
  /** Who sent the turn's message: its principal's kind, never its id. */
  readonly principalKind?: string;
  /** What a person sent, as `gen_ai.input.messages` (only with `user` content). */
  readonly input?: string;
}

/**
 * How spans are made: the trace key, the content the installation exports, and the most UTF-8
 * bytes of one content attribute (the Tenant's Runtime limit `traceContentBytes`).
 */
export interface SpanSettings {
  readonly key: TraceKey;
  readonly content: TraceContent;
  readonly contentBytes: number;
}

/**
 * The trace of turn `turnId` of session `sessionId`, from its `command.message` when the log has
 * it: the inbound `traceparent`'s trace id and parent, else derived ids.
 */
export function turnTraceOf(
  settings: SpanSettings,
  ids: { tenantId: string; sessionId: string; turnId: string },
  message?: Pick<LiveEvent, "payload" | "principal"> | undefined,
): TurnTrace {
  const payload = (message?.payload ?? {}) as {
    trace?: { traceparent?: unknown };
    content?: unknown;
    parts?: unknown;
    data?: unknown;
  };
  const inbound =
    typeof payload.trace?.traceparent === "string" ? parseTraceparent(payload.trace.traceparent) : undefined;
  const input = settings.content.has("user") && message ? userMessages(payload, settings.contentBytes) : undefined;
  return {
    traceId: inbound?.traceId ?? traceIdOf(settings.key, ids.tenantId, ids.sessionId, ids.turnId),
    spanId: turnSpanOf(settings.key, ids.turnId),
    ...(inbound ? { parentSpanId: inbound.spanId } : {}),
    ...(message?.principal ? { principalKind: message.principal.kind } : {}),
    ...(input === undefined ? {} : { input }),
  };
}

/** The span `row` makes in its turn's trace, or undefined when it makes none. */
export function spanOf(row: LiveEvent, turn: TurnTrace, settings: SpanSettings): OtlpSpan | undefined {
  if (row.turnId === null || row.visibility === "internal") return undefined;
  const p = (row.payload ?? {}) as Record<string, any>;
  const base = new Attributes()
    .str("gen_ai.conversation.id", row.sessionId)
    .str("nylorun.turn.id", row.turnId)
    .str("nylorun.event.cursor", row.cursor)
    .str("nylorun.source.kind", row.source.kind)
    // A client's source id is its principal, a person's id when it acts for one: never exported.
    .str("nylorun.source.id", row.source.kind === "client" ? undefined : row.source.id)
    .str("nylorun.evidence", row.evidence)
    .str("nylorun.run.id", row.runId ?? undefined);
  const child = (spanId: string, name: string, kind: number) => ({
    traceId: turn.traceId,
    spanId,
    parentSpanId: turn.spanId,
    name,
    kind,
  });
  const effectSpan = (effectId: unknown) =>
    typeof effectId === "string" && effectId.length > 0
      ? effectSpanOf(settings.key, effectId)
      : eventSpanOf(settings.key, row.sessionId, row.seq);
  const content = (kind: TraceContentKind, value: unknown) =>
    settings.content.has(kind) && value !== undefined ? truncate(typeof value === "string" ? value : JSON.stringify(value), settings.contentBytes) : undefined;
  switch (row.type) {
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      const status = row.type.slice("turn.".length);
      // The agent the turn ran: its manifest's name (protocol 16), else the Agent's id.
      const manifest = p.manifest as { name?: unknown; version?: unknown } | undefined;
      const agentName = typeof manifest?.name === "string" ? manifest.name : typeof p.agentId === "string" ? p.agentId : undefined;
      const totals = p.totals as { steps?: number; tokens?: number; costUsd?: number } | undefined;
      const error = row.type === "turn.failed" ? ((p.error ?? {}) as { code?: string; message?: string }) : undefined;
      const attributes = base
        .str("gen_ai.operation.name", "invoke_agent")
        .str("gen_ai.agent.id", p.agentId)
        .str("gen_ai.agent.name", agentName)
        // The agent manifest version the turn ran (T3): an Agent moves between versions.
        .int("nylorun.manifest.version", typeof manifest?.version === "number" ? manifest.version : undefined)
        .str("nylorun.turn.status", status)
        .int("nylorun.turn.paused_ms", p.pausedMs)
        .int("nylorun.turn.steps", totals?.steps)
        .int("nylorun.turn.tokens", totals?.tokens)
        .double("nylorun.usage.cost_usd", totals?.costUsd)
        .str("nylorun.principal.kind", turn.principalKind)
        .str("error.type", error ? (error.code ?? "turn.failed") : undefined)
        .str("gen_ai.input.messages", turn.input)
        .str(
          "gen_ai.output.messages",
          row.type === "turn.completed" && p.output !== undefined && p.output !== null
            ? content("outputs", [{ role: "assistant", parts: [textPart(p.output)] }])
            : undefined,
        );
      return {
        traceId: turn.traceId,
        spanId: turn.spanId,
        ...(turn.parentSpanId ? { parentSpanId: turn.parentSpanId } : {}),
        name: agentName === undefined ? "invoke_agent" : `invoke_agent ${agentName}`,
        kind: SPAN_KIND.internal,
        ...window(row.time, p.durationMs),
        attributes: attributes.list,
        status:
          row.type === "turn.failed"
            ? errorStatus(content("errors", error?.message ?? p.message))
            : row.type === "turn.completed"
              ? { code: STATUS.ok }
              : { code: STATUS.unset },
      };
    }
    case "message.assistant":
    case "model.failed":
    case "context.compacted": {
      const model = p.model as { provider?: string; model?: string } | undefined;
      const metered = p.meteredUsage as
        | { inputTokens?: number; outputTokens?: number; cachedTokens?: number; costUsd?: number }
        | undefined;
      const reported = p.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const usage = metered ?? reported;
      const mismatch =
        metered !== undefined &&
        reported !== undefined &&
        (metered.inputTokens !== reported.inputTokens || metered.outputTokens !== reported.outputTokens);
      const output =
        row.type === "message.assistant"
          ? content("outputs", [
              {
                role: "assistant",
                parts: [
                  ...(typeof p.text === "string" && p.text !== "" ? [{ type: "text", content: p.text }] : []),
                  ...((p.toolCalls ?? []) as { callId: string; name: string; input: unknown }[]).map((call) => ({
                    type: "tool_call",
                    id: call.callId,
                    name: call.name,
                    arguments: call.input,
                  })),
                ],
                ...(typeof p.finishReason === "string" ? { finish_reason: p.finishReason } : {}),
              },
            ])
          : undefined;
      const attributes = base
        .str("gen_ai.operation.name", "chat")
        .str("gen_ai.provider.name", model?.provider)
        .str("gen_ai.response.model", model?.model)
        .strings("gen_ai.response.finish_reasons", typeof p.finishReason === "string" ? [p.finishReason] : undefined)
        .int("gen_ai.usage.input_tokens", usage?.inputTokens)
        .int("gen_ai.usage.output_tokens", usage?.outputTokens)
        .int("gen_ai.usage.cache_read.input_tokens", metered?.cachedTokens)
        .double("nylorun.usage.cost_usd", metered?.costUsd)
        .str("nylorun.usage.source", metered ? "gate" : reported ? "harness" : undefined)
        .bool("nylorun.usage.mismatch", mismatch ? true : undefined)
        .double("gen_ai.response.time_to_first_chunk", typeof p.firstTokenMs === "number" ? p.firstTokenMs / 1000 : undefined)
        .str("gen_ai.agent.id", p.agent?.id)
        .str("nylorun.effect.id", p.effectId)
        .int("nylorun.effect.window_ms", p.durationMs)
        .str("nylorun.compaction.trigger", row.type === "context.compacted" ? p.trigger : undefined)
        .str("error.type", row.type === "model.failed" ? p.code : undefined)
        .str("gen_ai.output.messages", output);
      return {
        ...child(effectSpan(p.effectId), model?.model ? `chat ${model.model}` : "chat", SPAN_KIND.client),
        ...timesOf(row.time, p.gate, p.durationMs),
        attributes: attributes.list,
        status: row.type === "model.failed" ? errorStatus(content("errors", p.message)) : { code: STATUS.ok },
      };
    }
    case "tool.completed":
    case "node.completed": {
      const node = row.type === "node.completed";
      const name = String(node ? p.key : p.toolName);
      const kind = p.kind;
      const error = p.error as { code?: string; message?: string } | undefined;
      const failed = p.status === "failed" || p.status === "cancelled" || error !== undefined;
      const policy = p.policy as { decision?: string; reason?: string } | undefined;
      const attributes = base
        .str("gen_ai.operation.name", "execute_tool")
        .str("gen_ai.tool.name", name)
        .str("gen_ai.tool.call.id", node ? undefined : p.callId)
        .str("gen_ai.tool.type", kind === "mcp" || kind === "http" ? "extension" : kind ? "function" : undefined)
        .str("gen_ai.agent.id", p.agent?.id)
        .str("nylorun.tool.kind", kind)
        .str("nylorun.tool.server", p.server)
        .str("nylorun.tool.identity", p.tool)
        .str("nylorun.tool.status", p.status)
        .int("nylorun.tool.attempts", p.attempts)
        .int("nylorun.tool.redacted", p.redacted)
        .str("nylorun.flow.path", node ? p.path : undefined)
        .str("nylorun.policy.decision", policy?.decision)
        .str("nylorun.policy.reason", policy?.reason)
        .str("nylorun.effect.id", p.effectId)
        .int("nylorun.effect.window_ms", p.durationMs)
        .str("error.type", failed ? (error?.code ?? `tool.${p.status}`) : undefined)
        .str("gen_ai.tool.call.result", node || p.output === undefined ? undefined : content("tool-results", p.output));
      return {
        ...child(effectSpan(p.effectId), `execute_tool ${name}`, SPAN_KIND.internal),
        ...timesOf(row.time, p.gate, p.durationMs),
        attributes: attributes.list,
        status: failed ? errorStatus(content("errors", error?.message)) : { code: STATUS.ok },
      };
    }
    case "effect.uncertain": {
      const effectId = String(p.effectId ?? "");
      const operation = effectId.includes(":tool:") ? "execute_tool" : "chat";
      return {
        ...child(effectSpan(effectId), operation, operation === "chat" ? SPAN_KIND.client : SPAN_KIND.internal),
        ...window(row.time, undefined),
        attributes: base
          .str("gen_ai.operation.name", operation)
          .str("nylorun.effect.id", effectId)
          .str("error.type", "effect.uncertain").list,
        status: errorStatus(content("errors", p.message)),
      };
    }
    case "turn.paused":
    case "command.approve":
    case "command.respond": {
      const interactions = (p.interactions ?? []) as { interaction?: { kind?: string } }[];
      const attributes = base
        .str("nylorun.interaction.id", row.type === "turn.paused" ? undefined : p.interactionId)
        .bool("nylorun.interaction.approved", row.type === "command.approve" ? p.approved === true : undefined)
        .strings(
          "nylorun.interaction.kinds",
          row.type === "turn.paused" ? interactions.map((entry) => String(entry.interaction?.kind ?? "")) : undefined,
        )
        .str("nylorun.principal.kind", row.type === "turn.paused" ? undefined : row.principal?.kind);
      return {
        ...child(eventSpanOf(settings.key, row.sessionId, row.seq), row.type, SPAN_KIND.internal),
        ...window(row.time, undefined),
        attributes: attributes.list,
        status: { code: STATUS.unset },
      };
    }
    default:
      return undefined;
  }
}

/** Builds a span's attributes in order, leaving out absent values. */
class Attributes {
  readonly list: OtlpKeyValue[] = [];
  str(key: string, value: unknown): this {
    if (typeof value === "string" && value !== "") this.list.push({ key, value: { stringValue: value } });
    return this;
  }
  int(key: string, value: unknown): this {
    if (typeof value === "number" && Number.isFinite(value))
      this.list.push({ key, value: { intValue: String(Math.round(value)) } });
    return this;
  }
  double(key: string, value: unknown): this {
    if (typeof value === "number" && Number.isFinite(value)) this.list.push({ key, value: { doubleValue: value } });
    return this;
  }
  bool(key: string, value: unknown): this {
    if (typeof value === "boolean") this.list.push({ key, value: { boolValue: value } });
    return this;
  }
  strings(key: string, value: unknown): this {
    if (Array.isArray(value) && value.length > 0)
      this.list.push({ key, value: { arrayValue: { values: value.map((item) => ({ stringValue: String(item) })) } } });
    return this;
  }
}

/** Unix milliseconds as OTLP's decimal nanoseconds. */
function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/** Ends at the row's time and starts `durationMs` before it (no length without one). */
function window(time: string, durationMs: unknown): { startTimeUnixNano: string; endTimeUnixNano: string } {
  const end = Date.parse(time);
  const length = typeof durationMs === "number" && durationMs > 0 ? durationMs : 0;
  return { startTimeUnixNano: nanos(end - length), endTimeUnixNano: nanos(end) };
}

/** The gate's own start and end when it measured the call, else the journal's window. */
function timesOf(time: string, gate: unknown, durationMs: unknown) {
  const measured = gate as { startedAt?: unknown; endedAt?: unknown } | undefined;
  const start = Date.parse(String(measured?.startedAt));
  const end = Date.parse(String(measured?.endedAt));
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
    return { startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end) };
  return window(time, durationMs);
}

function errorStatus(message: string | undefined): { code: number; message?: string } {
  return { code: STATUS.error, ...(message ? { message } : {}) };
}

/** A GenAI message part for a value: text as is, anything else as JSON text. */
function textPart(value: unknown): { type: "text"; content: string } {
  return { type: "text", content: typeof value === "string" ? value : JSON.stringify(value) };
}

/** What a person sent (`command.message`), as `gen_ai.input.messages`. */
function userMessages(
  payload: { content?: unknown; parts?: unknown; data?: unknown },
  maxBytes: number,
): string | undefined {
  const parts =
    typeof payload.content === "string"
      ? [{ type: "text", content: payload.content }]
      : Array.isArray(payload.parts)
        ? (payload.parts as { type?: string; text?: string; artifactId?: string; version?: number }[]).map((part) =>
            part.type === "text"
              ? { type: "text", content: part.text ?? "" }
              : { type: "file", artifact_id: part.artifactId, ...(part.version ? { version: part.version } : {}) },
          )
        : payload.data !== undefined
          ? [textPart(payload.data)]
          : undefined;
  return parts ? truncate(JSON.stringify([{ role: "user", parts }]), maxBytes) : undefined;
}

/** `value` cut to `maxBytes` of UTF-8, never in the middle of a character. */
export function truncate(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
