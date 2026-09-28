/**
 * Transcript events (Host feature `transcript-events`): what a chat UI shows, written in the
 * transaction that completes the effect, so a replayed effect never writes them again.
 * Payload schemas: `@nylorun/core/contracts` (`parseTranscriptEvent`).
 */
import type { HostEffect } from "@nylorun/harness/run";

/** The model's tool call id and the harness invocation, for tool effects and tool actions. */
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
  return { invocationId, text, toolCalls, ...agentOf(request) };
}

/** `tool.completed` for an MCP or sandbox tool: its output, or the tool error it reported. */
export function toolCompleted(request: HostEffect, value: unknown) {
  const ids = toolIds(request.context);
  if (!("callId" in ids)) return undefined;
  const outcome = value as {
    kind?: unknown;
    output?: unknown;
    code?: unknown;
    message?: unknown;
  } | null;
  const result =
    outcome?.kind === "failed"
      ? {
          error: {
            code: String(outcome.code ?? "tool.failed"),
            message: String(outcome.message ?? ""),
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
