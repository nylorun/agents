import { eventLabel, eventSummary, type StudioEvent } from "./event-presentation.ts";

export type EventExportFormat = "json" | "csv";

const CSV_COLUMNS = ["time", "type", "label", "summary", "delivery", "eventId", "turnId"] as const;

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The events as a file: JSON keeps each event whole, CSV is one line per table row. */
export function eventExport(
  events: readonly StudioEvent[],
  format: EventExportFormat,
): Readonly<{ text: string; contentType: string }> {
  if (format === "json")
    return { text: JSON.stringify(events, null, 2) + "\n", contentType: "application/json" };
  const rows = events.map((event) =>
    [
      event.time,
      event.type,
      eventLabel(event),
      eventSummary(event),
      event.committed ? "History" : "Live",
      event.eventId,
      event.turnId ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return {
    text: [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n",
    contentType: "text/csv",
  };
}

/** `events-<session>.<ext>`, or `events.<ext>` without a session. */
export function eventExportName(sessionId: string | undefined, format: EventExportFormat): string {
  const id = sessionId?.replace(/[^\w.-]+/g, "_");
  return `events${id ? `-${id}` : ""}.${format}`;
}
