/**
 * An AG-UI transcript rebuilt from a session's log, with the ids a live run gave each
 * message (see `translate.ts`), usable as `HttpAgent`'s `initialMessages`. A user message with
 * files has array content: its text parts, and each file as a media part whose source is the
 * artifact (`{ type: "file", provider: "nylorun", value: <artifact id> }`), typed by the media
 * type its `artifact.created` event recorded.
 */
import type { AssistantMessage, ContentPart, Message } from "@ag-ui/core";
import {
  isEmptyAssistantMessage,
  parseTranscriptEvent,
  type LiveEvent,
} from "@nylorun/core/contracts";
import { outputText, toolResultOf } from "./translate.js";

/** The `provider` of a file source that names one of the Tenant's artifacts. */
export const NYLORUN_FILE_PROVIDER = "nylorun";

type StoredPart = { type?: string; text?: unknown; artifactId?: unknown };

/** A file part as an AG-UI media part, its kind from its media type when the log has it. */
function filePart(artifactId: string, mediaType: string | undefined): ContentPart {
  const top = mediaType?.split("/")[0];
  const type = top === "image" || top === "audio" || top === "video" ? top : "document";
  return {
    type,
    source: {
      type: "file",
      value: artifactId,
      provider: NYLORUN_FILE_PROVIDER,
      ...(mediaType ? { mimeType: mediaType } : {}),
    },
  };
}

/** A message's parts (protocol 6): its text, or text and media parts when it has files. */
function partsContent(
  parts: readonly StoredPart[],
  mediaTypes: ReadonlyMap<string, string>
): string | ContentPart[] {
  if (!parts.some((part) => part.type === "file"))
    return parts.flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("\n");
  return parts.flatMap((part): ContentPart[] =>
    part.type === "file" && typeof part.artifactId === "string"
      ? [filePart(part.artifactId, mediaTypes.get(part.artifactId))]
      : typeof part.text === "string"
      ? [{ type: "text", text: part.text }]
      : []
  );
}

export function messagesFromEvents(items: readonly LiveEvent[]): Message[] {
  const messages: Message[] = [];
  const results = new Set<string>();
  // Each artifact's media type, from its events, for the files a message names.
  const mediaTypes = new Map<string, string>();
  let sawAssistant = false;
  for (const raw of items) {
    if (raw.type === "artifact.created" || raw.type === "artifact.version.created") {
      const p = (raw.payload ?? {}) as { artifactId?: unknown; contentType?: unknown };
      if (typeof p.artifactId === "string" && typeof p.contentType === "string")
        mediaTypes.set(p.artifactId, p.contentType);
      continue;
    }
    if (raw.type === "command.message") {
      const p = (raw.payload ?? {}) as {
        idempotencyKey?: string;
        content?: unknown;
        data?: unknown;
        parts?: StoredPart[];
      };
      messages.push({
        // The AG-UI endpoint sends the client's message id as the idempotency key.
        id: p.idempotencyKey ?? raw.eventId,
        role: "user",
        content:
          typeof p.content === "string"
            ? p.content
            : Array.isArray(p.parts)
            ? partsContent(p.parts, mediaTypes)
            : JSON.stringify(p.data),
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
    // A step that said nothing is in the log for its timing (R7.1), never a message.
    if (event.type === "message.assistant" && isEmptyAssistantMessage(event.payload)) continue;
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
