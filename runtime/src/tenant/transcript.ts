/**
 * Transcript events (Host feature `transcript-events`): what a chat UI shows, written in the
 * transaction that completes the effect, so a replayed effect never writes them again.
 * Payload schemas: `@nylorun/core/contracts` (`parseTranscriptEvent`).
 */
import type { HostEffect } from "@nylorun/harness/run";
import { isModelFailureOutcome } from "@nylorun/core/define";

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
 * provider returns a `ModelCandidate` or a bare string; anything else writes no event.
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
  if (!text && toolCalls.length === 0) return undefined;
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
 * engine replaced the older transcript with that summary.
 */
export function contextCompacted(request: HostEffect, value: unknown) {
  const compaction = (request.context as {
    compaction?: { trigger?: unknown; tokensBefore?: unknown; keptTokens?: unknown; partial?: unknown };
  } | null)?.compaction;
  if (!compaction || compaction.partial || isModelFailureOutcome(value)) return undefined;
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

/** `tool.completed` for a tool the Runtime ran: its output, or the tool error it reported. */
export function toolCompleted(request: HostEffect, value: unknown) {
  const ids = toolIds(request.context);
  if (!("callId" in ids)) return undefined;
  const outcome = value as {
    kind?: unknown;
    output?: unknown;
    code?: unknown;
    message?: unknown;
    server?: unknown;
    vault?: unknown;
  } | null;
  const result =
    outcome?.kind === "failed"
      ? {
          error: {
            code: String(outcome.code ?? "tool.failed"),
            message: String(outcome.message ?? ""),
            // `credential_rejected` (R2b C1): which server, and which vault's credential.
            ...(typeof outcome.server === "string" ? { server: outcome.server } : {}),
            ...(outcome.vault === "installation" || outcome.vault === "user"
              ? { vault: outcome.vault }
              : {}),
          },
        }
      : { output: outcome?.kind === "completed" ? outcome.output : value };
  return {
    ...ids,
    capabilityId: request.capabilityId!,
    toolName: request.toolName!,
    ...result,
    ...agentOf(request),
  };
}
