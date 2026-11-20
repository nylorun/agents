import { eventLayer } from "@nylorun/agents";
import type { StudioEvent } from "./event-presentation.ts";

/**
 * Whose account the rows are (ADR-159): the agent's record (what it saw and did), the Runtime's
 * (what the Runtime did to the session), or both. A type this Studio doesn't know shows under All.
 */
export type EventView = "agent" | "runtime" | "all";
export const EVENT_VIEWS: readonly { value: EventView; label: string; title: string }[] = [
  { value: "agent", label: "Agent", title: "What the agent saw and did" },
  { value: "runtime", label: "Runtime", title: "What the Runtime did to the session" },
  { value: "all", label: "All", title: "Every event, in order" },
];

/** True when an event belongs in a view. */
export function inView(type: string, view: EventView): boolean {
  return view === "all" || eventLayer(type) === view;
}

/** Who wrote an event and how sure the record is: `loop · claimed`, `api · observed`. */
export function writerOf(event: Pick<StudioEvent, "source" | "evidence">): string {
  return event.evidence ? `${event.source.kind} · ${event.evidence}` : event.source.kind;
}
