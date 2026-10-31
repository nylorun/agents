/**
 * The Nylorun A2A profile, v2: the five extensions' URIs, the data each carries, and readers
 * that find it in whatever a client holds (a task, a push's `StreamResponse`, a status update, a
 * message, an artifact). A reader answers `undefined` (or `[]`) when the data is missing or not
 * the profile's shape, so a core-tier agent outside Nylorun reads as plain A2A.
 */
import type { Artifact, Metadata } from "./types.js";

/** The profile's extension URIs, exactly as agents declare them on the card. */
export const A2A_EXTENSIONS = {
  /** An open interaction on a status message; the caller's answer on its reply. */
  interactions: "https://docs.nylorun.com/a2a/interactions/v1",
  /** `uncertain`: the effect whose outcome was lost. */
  effects: "https://docs.nylorun.com/a2a/effects/v1",
  /** The agent's plan, whole each time. */
  progress: "https://docs.nylorun.com/a2a/progress/v1",
  /** Totals and the trace id, on the terminal status update. */
  telemetry: "https://docs.nylorun.com/a2a/telemetry/v1",
  /** Each file artifact's kind, path, version, size and digest. */
  files: "https://docs.nylorun.com/a2a/files/v1",
} as const;

export type A2aExtensionUri = (typeof A2A_EXTENSIONS)[keyof typeof A2A_EXTENSIONS];

/** Every profile v2 extension: what a client activates by default. */
export const A2A_PROFILE_EXTENSIONS: readonly A2aExtensionUri[] = Object.values(A2A_EXTENSIONS);

export type A2aPlanStepState = "pending" | "active" | "done" | "blocked" | "skipped";

export interface A2aPlanStep {
  label: string;
  state: A2aPlanStepState;
  note?: string;
}

/** `progress/v1`: the whole plan, never a diff. */
export interface A2aProgress {
  steps: A2aPlanStep[];
}

/** `telemetry/v1`, on the terminal status update. */
export interface A2aTelemetry {
  totals?: { steps: number; tokens: number; costUsd: number };
  /** The caller's `traceparent` trace id when one was sent, else the Runtime's own. */
  traceId?: string;
}

/** `interactions/v1`: what the agent waits for. `approval` and `connection` pause as `AUTH_REQUIRED`. */
export interface A2aInteraction {
  interactionId: string;
  kind: "approval" | "question" | "connection" | (string & {});
  prompt?: string;
  detail?: unknown;
}

/** `effects/v1`. */
export interface A2aEffects {
  /** The effect id whose outcome was lost; the task stays `WORKING`. */
  uncertain?: string;
}

/** `files/v1`, on an artifact that comes from a file the agent wrote. */
export interface A2aFile {
  kind: string;
  /** Its path in the agent's outputs. */
  path?: string;
  version?: number;
  size?: number;
  sha256?: string;
}

/** An artifact with its `files/v1` data. */
export interface A2aFileArtifact {
  artifact: Artifact;
  file: A2aFile;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The objects whose `metadata` may hold extension data, most specific first. */
function holders(source: unknown): Record<string, unknown>[] {
  if (!isObject(source)) return [];
  for (const key of ["statusUpdate", "artifactUpdate", "task", "message"] as const)
    if (isObject(source[key])) return holders(source[key]);
  const found = [source];
  const status = isObject(source.status) ? source.status : undefined;
  if (status && isObject(status.message)) found.push(status.message);
  if (isObject(source.artifact)) found.push(source.artifact);
  return found;
}

/**
 * The data under extension `uri` in `source`'s metadata: an update event's own first, then its
 * status message's. `source` may be a `StreamResponse`, a task, a status update, a status, a
 * message or an artifact.
 */
export function readExtension(source: unknown, uri: string): unknown {
  for (const holder of holders(source)) {
    const metadata = holder.metadata;
    if (isObject(metadata) && metadata[uri] !== undefined) return metadata[uri];
  }
  return undefined;
}

const STEP_STATES: ReadonlySet<string> = new Set(["pending", "active", "done", "blocked", "skipped"]);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** `progress/v1`'s plan; steps that are not the profile's shape are left out. */
export function readProgress(source: unknown): A2aProgress | undefined {
  const data = readExtension(source, A2A_EXTENSIONS.progress);
  if (!isObject(data) || !Array.isArray(data.steps)) return undefined;
  const steps: A2aPlanStep[] = [];
  for (const step of data.steps) {
    if (!isObject(step) || typeof step.label !== "string" || typeof step.state !== "string")
      continue;
    if (!STEP_STATES.has(step.state)) continue;
    steps.push({
      label: step.label,
      state: step.state as A2aPlanStepState,
      ...(typeof step.note === "string" ? { note: step.note } : {}),
    });
  }
  return { steps };
}

/** `telemetry/v1`'s totals and trace id. */
export function readTelemetry(source: unknown): A2aTelemetry | undefined {
  const data = readExtension(source, A2A_EXTENSIONS.telemetry);
  if (!isObject(data)) return undefined;
  const totals = isObject(data.totals) ? data.totals : undefined;
  const result: A2aTelemetry = {};
  if (totals && finite(totals.steps) && finite(totals.tokens) && finite(totals.costUsd))
    result.totals = { steps: totals.steps, tokens: totals.tokens, costUsd: totals.costUsd };
  if (typeof data.traceId === "string") result.traceId = data.traceId;
  return result.totals || result.traceId ? result : undefined;
}

/** `interactions/v1`'s open interaction, from a status (update) or its message. */
export function readInteraction(source: unknown): A2aInteraction | undefined {
  const data = readExtension(source, A2A_EXTENSIONS.interactions);
  if (!isObject(data) || typeof data.interactionId !== "string" || data.interactionId === "")
    return undefined;
  return {
    interactionId: data.interactionId,
    kind: typeof data.kind === "string" ? data.kind : "question",
    ...(typeof data.prompt === "string" ? { prompt: data.prompt } : {}),
    ...(data.detail !== undefined ? { detail: data.detail } : {}),
  };
}

/** `effects/v1`: the effect whose outcome was lost. */
export function readEffects(source: unknown): A2aEffects | undefined {
  const data = readExtension(source, A2A_EXTENSIONS.effects);
  if (!isObject(data)) return undefined;
  return typeof data.uncertain === "string" ? { uncertain: data.uncertain } : {};
}

function fileOf(artifact: unknown): A2aFileArtifact | undefined {
  if (!isObject(artifact) || typeof artifact.artifactId !== "string") return undefined;
  const metadata = artifact.metadata as Metadata | undefined;
  const data = isObject(metadata) ? metadata[A2A_EXTENSIONS.files] : undefined;
  if (!isObject(data) || typeof data.kind !== "string") return undefined;
  return {
    artifact: artifact as unknown as Artifact,
    file: {
      kind: data.kind,
      ...(typeof data.path === "string" ? { path: data.path } : {}),
      ...(finite(data.version) ? { version: data.version } : {}),
      ...(finite(data.size) ? { size: data.size } : {}),
      ...(typeof data.sha256 === "string" ? { sha256: data.sha256 } : {}),
    },
  };
}

/**
 * The artifacts with `files/v1` data: a task's, an artifact update's, or one artifact. Others
 * (the turn's `output`, a core-tier agent's) are left out.
 */
export function readFiles(source: unknown): A2aFileArtifact[] {
  if (!isObject(source)) return [];
  if (isObject(source.task)) return readFiles(source.task);
  if (isObject(source.artifactUpdate)) return readFiles(source.artifactUpdate);
  const artifacts = Array.isArray(source.artifacts)
    ? source.artifacts
    : isObject(source.artifact)
      ? [source.artifact]
      : [source];
  return artifacts.flatMap((artifact) => fileOf(artifact) ?? []);
}
