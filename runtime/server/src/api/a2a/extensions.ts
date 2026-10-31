/**
 * The Nylorun A2A profile v2 (`docs.nylorun.com/a2a/profile/v2`, Host feature `a2a-profile-v2`):
 * five extensions, each declared on the Agent Card with `required: false`. A client activates
 * them with the `A2A-Extensions` request header (A2A §4.6); the Runtime echoes the ones it
 * activated in the same header, and keeps the data of the others out of what it answers, so a
 * client that activates none gets plain A2A 1.0. Data travels in `metadata` keyed by the URI.
 */

/** The profile's page: every extension's card entry links it. */
export const A2A_PROFILE_URL = "https://docs.nylorun.com/a2a/profile/v2";

/** The extension URIs (exact strings; profile v2 §2). */
export const A2A_EXTENSIONS = {
  /** An open interaction on a status message, and the caller's answer on a reply message. */
  interactions: "https://docs.nylorun.com/a2a/interactions/v1",
  /** `uncertain`: the effect whose outcome was lost, on a status update. */
  effects: "https://docs.nylorun.com/a2a/effects/v1",
  /** The agent's plan (`plan.updated`), on working status updates and the task. */
  progress: "https://docs.nylorun.com/a2a/progress/v1",
  /** The turn's totals and trace id, on the terminal status update and the task. */
  telemetry: "https://docs.nylorun.com/a2a/telemetry/v1",
  /** A file artifact's kind, path, version, size and `sha256`. */
  files: "https://docs.nylorun.com/a2a/files/v1",
} as const;

export type A2aExtension = (typeof A2A_EXTENSIONS)[keyof typeof A2A_EXTENSIONS];

const ALL: ReadonlySet<string> = new Set(Object.values(A2A_EXTENSIONS));

/** Every extension: what a push config registered without the header keeps. */
export const ALL_EXTENSIONS: ReadonlySet<string> = ALL;

const DESCRIPTIONS: Readonly<Record<A2aExtension, string>> = {
  [A2A_EXTENSIONS.interactions]:
    "Typed approvals, questions and connection requests on the status message, answered on the same task",
  [A2A_EXTENSIONS.effects]: "The effect whose outcome was lost (`uncertain`) while the task stays working",
  [A2A_EXTENSIONS.progress]: "The agent's plan: up to 20 steps, each with a label, a state and a note",
  [A2A_EXTENSIONS.telemetry]: "The task's totals (steps, tokens, costUsd) and trace id, when it ends",
  [A2A_EXTENSIONS.files]: "Each file artifact's kind, path, version, size and sha256",
};

/** The card's `capabilities.extensions`: all five, optional, linking the profile. */
export function cardExtensions(): Record<string, unknown>[] {
  return Object.values(A2A_EXTENSIONS).map((uri) => ({
    uri,
    description: DESCRIPTIONS[uri],
    required: false,
    params: { profile: A2A_PROFILE_URL },
  }));
}

/**
 * The extensions an `A2A-Extensions` header activates: the comma-separated URIs this Runtime
 * serves, in the profile's order. Unknown URIs are ignored (A2A §4.6: an agent activates the
 * ones it supports).
 */
export function parseExtensions(header: string | null | undefined): Set<string> {
  const asked = new Set(
    (header ?? "")
      .split(",")
      .map((uri) => uri.trim())
      .filter((uri) => uri !== "")
  );
  return new Set(Object.values(A2A_EXTENSIONS).filter((uri) => asked.has(uri)));
}

/** The `A2A-Extensions` answer header for `active`, or undefined when none is. */
export function extensionsHeader(active: ReadonlySet<string>): string | undefined {
  return active.size === 0 ? undefined : [...active].join(", ");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `value` without the data of the extensions `active` leaves out: their keys in every `metadata`
 * object (an emptied one goes), and their URIs in every `extensions` list. Parts' `data` is the
 * agent's or caller's own and is never read. Returns a copy.
 */
export function keepExtensions<T>(value: T, active: ReadonlySet<string>): T {
  if (active.size === ALL.size) return value;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "data") out[key] = child;
      else if (key === "metadata" && isObject(child)) {
        const kept = Object.fromEntries(
          Object.entries(child).filter(([name]) => !ALL.has(name) || active.has(name))
        );
        if (Object.keys(kept).length > 0) out[key] = kept;
      } else if (key === "extensions" && Array.isArray(child)) {
        const kept = child.filter((uri) => typeof uri !== "string" || !ALL.has(uri) || active.has(uri));
        if (kept.length > 0) out[key] = kept;
      } else out[key] = walk(child);
    }
    return out;
  };
  return walk(value) as T;
}
