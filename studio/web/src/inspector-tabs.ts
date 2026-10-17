/**
 * The tabs beside a session's chat, one per kind of data and the same for agent and workflow
 * sessions: Manifest (what the agent is), Record (what the session holds), Events (what
 * happened) and Usage (what it cost). Manifest and Events have views; a workflow adds Progress
 * and Iterations to Events. `?inspector=` names the tab and `?view=` its view.
 */

export type InspectorTab = "manifest" | "record" | "events" | "usage";
/** The Manifest tab's views: the manifest the session pinned, and the Agent it runs on. */
export type ManifestTabView = "declared" | "deployed";
/** The Events tab's views; `progress` and `iterations` are a workflow's. */
export type EventsTabView = "log" | "progress" | "iterations";

export interface InspectorPlace {
  tab: InspectorTab;
  manifestView: ManifestTabView;
  eventsView: EventsTabView;
}

/** The Events view a session opens on: a workflow's progress, else the log. */
export function defaultEventsView(isWorkflow: boolean): EventsTabView {
  return isWorkflow ? "progress" : "log";
}

/**
 * Where `?inspector=` and `?view=` put the inspector. The tab names before the four tabs keep
 * working: `agent` (and `environment`, its name before protocol 16) is Manifest's deployed view,
 * `artifacts` is Record, `tree` and `iterations` are Events' workflow views. Anything else
 * opens Events.
 */
export function inspectorPlace(
  asked: string | null,
  view: string | null,
  isWorkflow: boolean,
): InspectorPlace {
  const place: InspectorPlace = {
    tab: "events",
    manifestView: "declared",
    eventsView: defaultEventsView(isWorkflow),
  };
  switch (asked) {
    case "manifest":
      place.tab = "manifest";
      if (view === "deployed") place.manifestView = "deployed";
      break;
    case "agent":
    case "environment":
      place.tab = "manifest";
      place.manifestView = "deployed";
      break;
    case "record":
    case "artifacts":
      place.tab = "record";
      break;
    case "usage":
      place.tab = "usage";
      break;
    case "tree":
      if (isWorkflow) place.eventsView = "progress";
      break;
    case "iterations":
      if (isWorkflow) place.eventsView = "iterations";
      break;
    default:
      if (view === "log" || (isWorkflow && (view === "progress" || view === "iterations")))
        place.eventsView = view;
  }
  return place;
}
