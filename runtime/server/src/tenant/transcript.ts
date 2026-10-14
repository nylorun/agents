/**
 * Transcript events (Host feature `transcript-events`): what a chat UI shows, written in the
 * transaction that completes the effect, so a replayed effect never writes them again.
 * Payload schemas: `@nylorun/core/contracts` (`parseTranscriptEvent`).
 */
import type { HostEffect } from "@nylorun/harness/run";
import type { TOOL_CALL_KINDS, TOOL_CALL_STATUSES } from "@nylorun/core/contracts";
import { isModelFailureOutcome } from "@nylorun/core/define";

export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
export type ToolCallKind = (typeof TOOL_CALL_KINDS)[number];

/** The model's tool call id and the harness invocation, for tool effects. */
export function toolIds(
  context: unknown
): { callId: string; invocationId: string } | Record<string, never> {
  const c = context as { callId?: unknown; invocationId?: unknown } | null;
  return typeof c?.callId === "string" && typeof c.invocationId === "string"
    ? { callId: c.callId, invocationId: c.invocationId }
    : {};
}

const agentOf = (request: HostEffect) =>
  request.agent ? { agent: request.agent } : {};

/**
 * `message.assistant` for a completed model effect: the step's text and tool calls. The
 * provider returns a `ModelCandidate` or a bare string. A step that said nothing (no text, no
 * tool calls; a structured answer) is still one event, with `text: ""` (R7.1): every model call
 * has its outcome row. Readers that build a conversation skip it (`isEmptyAssistantMessage`).
 */
export function assistantMessage(request: HostEffect, value: unknown) {
  const invocationId = (request.context as { invocationId?: unknown })
    ?.invocationId;
  if (typeof invocationId !== "string") return undefined;
  const blocks: unknown[] =
    typeof value === "string"
      ? [{ type: "text", text: value }]
      : Array.isArray((value as { output?: unknown } | null)?.output)
      ? (value as { output: unknown[] }).output
      : [];
  let text = "";
  const toolCalls: { callId: string; name: string; input: unknown }[] = [];
  for (const block of blocks as Record<string, unknown>[]) {
    if (block?.type === "text" && typeof block.text === "string")
      text += block.text;
    else if (
      block?.type === "tool-call" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    )
      toolCalls.push({ callId: block.id, name: block.name, input: block.args });
  }
  const candidate = (typeof value === "object" && value !== null ? value : {}) as {
    finishReason?: unknown;
    usage?: unknown;
    evidence?: { extras?: { producer?: { provider?: unknown; model?: unknown } } };
  };
  const producer = candidate.evidence?.extras?.producer;
  return {
    invocationId,
    text,
    toolCalls,
    ...(typeof producer?.provider === "string" && typeof producer.model === "string"
      ? { model: { provider: producer.provider, model: producer.model } }
      : {}),
    ...(typeof candidate.finishReason === "string"
      ? { finishReason: candidate.finishReason }
      : {}),
    ...(candidate.usage && typeof candidate.usage === "object"
      ? { usage: candidate.usage }
      : {}),
    ...agentOf(request),
  };
}

/**
 * `context.compacted` for a model effect that summarized history (Model Calls §8): the
 * engine replaced the older transcript with that summary. A partial summary (one call of
 * several) is marked `partial: true` (R7.1): only the last call's event replaced the history.
 */
export function contextCompacted(request: HostEffect, value: unknown) {
  const compaction = (request.context as {
    compaction?: { trigger?: unknown; tokensBefore?: unknown; keptTokens?: unknown; partial?: unknown };
  } | null)?.compaction;
  if (!compaction || isModelFailureOutcome(value)) return undefined;
  const summary =
    typeof value === "string"
      ? value
      : Array.isArray((value as { output?: unknown } | null)?.output)
      ? (value as { output: { type?: unknown; text?: unknown }[] }).output
          .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
          .join("")
      : "";
  const invocationId = (request.context as { invocationId?: unknown })?.invocationId;
  const tokensBefore = Number(compaction.tokensBefore) || 0;
  const keptTokens = Number(compaction.keptTokens) || 0;
  return {
    ...(typeof invocationId === "string" ? { invocationId } : {}),
    trigger: compaction.trigger === "overflow" ? ("overflow" as const) : ("threshold" as const),
    tokensBefore,
    tokensAfter: keptTokens + Math.ceil(summary.trim().length / 4),
    ...(compaction.partial ? { partial: true as const } : {}),
    ...agentOf(request),
  };
}

/** `model.failed` for a model effect that completed with a failure outcome (Model Calls §6.4). */
export function modelFailed(request: HostEffect, value: unknown) {
  if (!isModelFailureOutcome(value)) return undefined;
  const invocationId = (request.context as { invocationId?: unknown })
    ?.invocationId;
  return {
    ...(typeof invocationId === "string" ? { invocationId } : {}),
    code: value.code,
    message: value.message,
    retryable: value.retryable,
    ...agentOf(request),
  };
}

/** A gate's own start and end of a call (R7.1). */
export interface GateTimes {
  readonly startedAt: string;
  readonly endedAt: string;
}

/** What the usage ledger holds for a model call (R7.1): its `model_usage` row's columns. */
export interface MeteredCall {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly firstTokenMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
}

/** From `startedAt` to `endedAt` in whole milliseconds; undefined unless both are times. */
export function durationBetween(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const ended = endedAt ? Date.parse(endedAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return undefined;
  return Math.max(0, Math.round(ended - started));
}

/**
 * The timing a model call's outcome event carries (R7.1): its effect id, the journal's window
 * (`startedAt` on the row to `settledAt`), and, when the gate metered the call (`metered`), the
 * gate's own start and end, the first token's time and the metered usage.
 */
export function modelOutcomeFacts(
  effectId: string,
  window: { startedAt?: string; settledAt?: string },
  metered: MeteredCall | undefined,
) {
  const durationMs = durationBetween(window.startedAt, window.settledAt);
  return {
    effectId,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(metered?.startedAt && metered.endedAt
      ? { gate: { startedAt: metered.startedAt, endedAt: metered.endedAt } }
      : {}),
    ...(metered?.firstTokenMs !== null && metered?.firstTokenMs !== undefined
      ? { firstTokenMs: metered.firstTokenMs }
      : {}),
    ...(metered
      ? {
          meteredUsage: {
            inputTokens: metered.inputTokens,
            outputTokens: metered.outputTokens,
            totalTokens: metered.totalTokens,
            ...(metered.cachedTokens > 0 ? { cachedTokens: metered.cachedTokens } : {}),
            ...(metered.costUsd > 0 ? { costUsd: metered.costUsd } : {}),
          },
        }
      : {}),
  };
}

/** What the Tenant's tool policy did with a call, when it did more than allow it (R7.1). */
export interface ToolPolicyFact {
  readonly decision: "ask" | "deny";
  readonly reason: string;
  readonly approvedBy?: string;
}

/** What the journal knows of a tool call when it ends (R5.1, R7.1), for its `tool.completed`. */
export interface ToolCallFacts {
  readonly status: ToolCallStatus;
  readonly kind?: ToolCallKind;
  readonly server?: string;
  readonly attempts?: number;
  readonly durationMs?: number;
  readonly effectId?: string;
  readonly gate?: GateTimes;
  readonly policy?: ToolPolicyFact;
}

/**
 * `tool.completed` for a tool call that ended: its output, or the tool error it reported, and
 * how it ended (R5.1).
 */
export function toolCompleted(request: HostEffect, value: unknown, facts?: ToolCallFacts) {
  const ids = toolIds(request.context);
  if (!("callId" in ids)) return undefined;
  const outcome = value as {
    kind?: unknown;
    output?: unknown;
    code?: unknown;
    message?: unknown;
    server?: unknown;
    retryable?: unknown;
    redacted?: unknown;
  } | null;
  const result =
    outcome?.kind === "failed"
      ? {
          error: {
            code: String(outcome.code ?? "tool.failed"),
            message: String(outcome.message ?? ""),
            // `credential_rejected` (R2b C1): which server.
            ...(typeof outcome.server === "string" ? { server: outcome.server } : {}),
            ...(typeof outcome.retryable === "boolean" ? { retryable: outcome.retryable } : {}),
          },
        }
      : { output: outcome?.kind === "completed" ? outcome.output : value };
  // Credential values the server echoed, replaced before the outcome was recorded (R2b C8).
  const redacted =
    (outcome?.kind === "completed" || outcome?.kind === "failed") &&
    typeof outcome.redacted === "number" &&
    outcome.redacted > 0
      ? { redacted: outcome.redacted }
      : {};
  return {
    ...ids,
    toolName: request.toolName!,
    ...(facts
      ? {
          status: facts.status,
          ...(facts.kind === undefined ? {} : { kind: facts.kind }),
          ...(facts.server === undefined ? {} : { server: facts.server }),
          ...(facts.attempts === undefined ? {} : { attempts: facts.attempts }),
          ...(facts.durationMs === undefined ? {} : { durationMs: facts.durationMs }),
          ...(facts.effectId === undefined ? {} : { effectId: facts.effectId }),
          ...(facts.gate === undefined ? {} : { gate: facts.gate }),
          ...(facts.policy === undefined ? {} : { policy: facts.policy }),
        }
      : {}),
    ...result,
    ...redacted,
    ...agentOf(request),
  };
}
