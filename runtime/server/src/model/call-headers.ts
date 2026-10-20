/**
 * A custom endpoint's per-call headers (#493): each `callHeaders` entry's value, from the calling
 * Agent, for a gateway that attributes or budgets each call, such as by the Agent's `org` label.
 * A source with no value (a missing or empty label, a session whose owner is no person) sends no
 * header, never an empty one.
 */
import type { ModelCallHeaderSource } from "@nylorun/core/contracts";

/** What a model call knows of who makes it, read for the call. */
export interface ModelCaller {
  readonly agentId: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The session's owner, when it is a person. */
  readonly owner?: string;
}

export function callHeaders(
  sources: Readonly<Record<string, ModelCallHeaderSource>>,
  caller: ModelCaller,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, source] of Object.entries(sources)) {
    const value =
      source.from === "agent.label" ? caller.labels[source.key] : source.from === "agent.id" ? caller.agentId : caller.owner;
    if (value) headers[name] = value;
  }
  return headers;
}
