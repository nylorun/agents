/**
 * An AG-UI transcript rebuilt from a session's log, with the ids a live run gave each
 * message (see `translate.ts`), usable as `HttpAgent`'s `initialMessages`.
 */
import type { AssistantMessage, Message } from "@ag-ui/core";
import { parseTranscriptEvent, type LiveEvent } from "@nylorun/core/contracts";
import { outputText, toolResultOf } from "./translate.js";

export function messagesFromEvents(items: readonly LiveEvent[]): Message[] {
  const messages: Message[] = [];
  const results = new Set<string>();
  let sawAssistant = false;
  for (const raw of items) {
    if (raw.type === "command.message") {
      const p = (raw.payload ?? {}) as {
        idempotencyKey?: string;
        content?: unknown;
        data?: unknown;
      };
      messages.push({
        // The AG-UI endpoint sends the client's message id as the idempotency key.
        id: p.idempotencyKey ?? raw.eventId,
        role: "user",
        content:
          typeof p.content === "string" ? p.content : JSON.stringify(p.data),
      });
      sawAssistant = false;
      continue;
    }
    const event = parseTranscriptEvent(raw);
    if (!event) continue;
    const result = toolResultOf(event);
    if (result) {
      if (results.has(result.callId)) continue;
      results.add(result.callId);
      messages.push({
        id: `${result.callId}:result`,
        role: "tool",
        toolCallId: result.callId,
        content: result.content,
      });
      continue;
    }
    if (event.type === "message.assistant" && !event.payload.agent) {
      const p = event.payload;
      sawAssistant = true;
      const message: AssistantMessage = { id: p.invocationId, role: "assistant" };
      if (p.text) message.content = p.text;
      if (p.toolCalls.length)
        message.toolCalls = p.toolCalls.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
      messages.push(message);
    } else if (event.type === "turn.completed" && !sawAssistant) {
      const output = event.payload.output;
      if (output !== undefined && output !== null && outputText(output))
        messages.push({
          id: raw.eventId,
          role: "assistant",
          content: outputText(output),
        });
    }
  }
  return messages;
}
