/**
 * AG-UI over server-sent events: one `data:` line of JSON per event. The last AG-UI event
 * made from a Runtime event carries that event's cursor as `id:`, so a client that resumes
 * from `Last-Event-ID` never lands inside a group.
 */
import type { BaseEvent } from "@ag-ui/core";

export const SSE_CONTENT_TYPE = "text/event-stream";

export function sseFrame(event: BaseEvent, id?: string): string {
  // Cursors are opaque base64; a line break would end the field early.
  const idLine = id && !/[\r\n]/.test(id) ? `id: ${id}\n` : "";
  return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}

export const SSE_HEARTBEAT = ": keep-alive\n\n";
