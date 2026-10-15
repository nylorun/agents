/**
 * Harness API v4 (blueprint D37–D42; the harness boundary, protocol 15): the messages between
 * core and a harness. A run is a lease on one session's segment; core records, the harness runs
 * the engine. Who executes what: the harness runs model, MCP, HTTP and sandbox calls and its own
 * tools (our engine's skill, artifact and deferred-tool tools among them, over the
 * `definition.file` and artifact seams), writes the model's instructions, names the session's MCP
 * tools and shapes tool results; core runs flow work, linked sessions, delegation journaling,
 * settle and takeover, and routes each tool call by its target (`EffectTarget`: its kind, and an
 * MCP or HTTP tool's identity). Each message's type is inferred from its schema (`schema.ts`),
 * which a socket validates it with.
 */
import type { z } from "zod";
import type {
  ArtifactMetaSchema,
  CompactionFactsSchema,
  EffectIntentSchema,
  EffectTargetSchema,
  IntentAnswerSchema,
  ModelDescriptorSchema,
  OutcomeAnswerSchema,
  RecordedOutcomeSchema,
  ReleaseReasonSchema,
  RequestTypes,
  RunGrantSchema,
  RunRoutingSchema,
  TraceContextSchema,
  TurnEnvironmentSchema,
  TurnOutputSchema,
  TurnStartSchema,
  WorkspaceCallSchema,
  WorkspaceDiskCallSchema,
  WorkspaceRecordSchema,
  WorkspaceSessionSchema,
  coreMessages,
  coreRequests,
  harnessRequests,
} from "./schema.js";

export const HARNESS_API_VERSION = 4;

/** Why core stopped a run. Matches the advance's abort kinds. */
export const ABORT_REASONS = ["cancel", "shutdown", "deadline", "ownership.lost"] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

/** Why a harness gave a run back without an output. */
export type ReleaseReason = z.infer<typeof ReleaseReasonSchema>;

/**
 * Events a harness may claim: for a run it holds, or for a workspace request core sent it. A
 * `environment.state` claim carries the workspace's compute record, which core keeps. Our engine
 * claims `artifact.export.skipped` and `artifact.export.failed` when the turn-end save of its
 * outputs folder stores nothing (protocol 15).
 */
export const HARNESS_CLAIMS = [
  "environment.state",
  "environment.exec",
  "artifact.export.skipped",
  "artifact.export.failed",
] as const;
export type HarnessClaim = (typeof HARNESS_CLAIMS)[number];

export const HARNESS_ERROR_CODES = [
  "run_not_held",
  "turn_cancelled",
  "ownership_lost",
  "effect_drift",
  "invalid",
  "unavailable",
  "internal",
  /**
   * What the request names is not there for this run: an artifact that is missing, another
   * session's, or Tenant-wide and never named by the session's messages, all alike.
   */
  "not_found",
  /**
   * What the harness sent passes a Runtime limit (`turn.start.limits`): the message names the
   * limit and its value.
   */
  "limit_exceeded",
] as const;
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

/** One effect the engine asks for: a `HostEffect`, by structure. Model intents carry no `input`. */
export type EffectIntent = z.infer<typeof EffectIntentSchema>;

/** What a tool call runs: the record routes it by `kind` (protocol 15). */
export type EffectTarget = z.infer<typeof EffectTargetSchema>;

/** The Environment a turn runs in (`turn.start.environment`, protocol 15). */
export type TurnEnvironment = z.infer<typeof TurnEnvironmentSchema>;

/** An artifact as the artifact seam shows it to a harness (`artifact.read`, `artifact.write`). */
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

/** One `artifact.read` answer: the artifact, and up to one chunk of its bytes from `offset`. */
export type ArtifactReadResult = ResultOf<"artifact.read">;

/** One `artifact.write` request: `begin`, `chunk`, `commit` or `abort`; a folder's `file` too. */
export type ArtifactWriteParams = ParamsOf<"artifact.write">;

/**
 * One `artifact.write` answer: the upload `open`, the artifact `written`, a folder version
 * `refused` (past a total), or `aborted`.
 */
export type ArtifactWriteResult = ResultOf<"artifact.write">;

/** What a harness says of a compaction it made (`transcript.updated` with `kind: "compaction"`). */
export type CompactionFacts = z.infer<typeof CompactionFactsSchema>;

/** A completed outcome of the segment, with the hash of the request it answered. */
export type RecordedOutcome = z.infer<typeof RecordedOutcomeSchema>;

/** The lease on one run. `token` is the run token (F5) when the gates require one. */
export type RunGrant = z.infer<typeof RunGrantSchema>;

/** Where a harness sends the session's tool calls. */
export type RunRouting = z.infer<typeof RunRoutingSchema>;

/** W3C trace context a turn carries (R4.10). */
export type TraceContext = z.infer<typeof TraceContextSchema>;

/** The model a turn's calls use when they name none (`turn.start.model`, protocol 15). */
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

/** What a run starts from: `turn.start` (message, continue, resume) or `approval.answer`. */
export type TurnStart = z.infer<typeof TurnStartSchema>;

/**
 * A segment's end. `state` is the agent's engine state without its transcript; `transcript`
 * edits the transcript the segment started from. `thrown` reports an engine that threw.
 */
export type TurnOutput = z.infer<typeof TurnOutputSchema>;

/** How a segment ended, as the harness reports it. */
export type TurnStatus = NonNullable<TurnOutput["status"]>;

export type OutputMethod = "turn.completed" | "turn.paused" | "turn.waiting" | "turn.failed" | "checkpoint";

export type IntentAnswer = z.infer<typeof IntentAnswerSchema>;

export type OutcomeAnswer = z.infer<typeof OutcomeAnswerSchema>;

/** Requests a harness sends to core, with their answers. */
export type HarnessRequests = RequestTypes<typeof harnessRequests>;

/** The session a workspace request acts for, and the Environment whose workspace it is. */
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;

/** A workspace's compute record, as the harness keeps it. */
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/** A sandbox tool call core sends to the harness that serves workspaces. */
export type WorkspaceCall = z.infer<typeof WorkspaceCallSchema>;

/** One operation on a workspace's disk (R2d step 3). */
export type WorkspaceDiskCall = z.infer<typeof WorkspaceDiskCallSchema>;

/** Requests core sends to a harness that declared `workspace` (F6.2), with their answers. */
export type CoreRequests = RequestTypes<typeof coreRequests>;

/** Messages core sends to a harness, without an answer. */
export type CoreMessages = { [M in keyof typeof coreMessages]: z.infer<(typeof coreMessages)[M]> };

export type HarnessMethod = keyof HarnessRequests;
export type CoreMethod = keyof CoreRequests;
export type CoreMessage = keyof CoreMessages;
type Requests = HarnessRequests & CoreRequests;
export type ParamsOf<M extends keyof Requests> = Requests[M]["params"];
export type ResultOf<M extends keyof Requests> = Requests[M]["result"];
