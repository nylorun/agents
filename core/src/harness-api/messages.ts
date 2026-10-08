/**
 * Harness API v2 (blueprint D37–D42; v2 is track R2: no Actions, so no held runs): the messages
 * between core and a harness. A run is a lease on one session's segment; core records, the
 * harness runs the engine. Who executes what: the harness runs model, MCP, HTTP and sandbox
 * calls; core runs flow work, linked sessions, delegation journaling, `save_artifact`, the
 * skill tools, settle and takeover. Each message's type is inferred from its schema
 * (`schema.ts`), which a socket validates it with.
 */
import type { z } from "zod";
import type {
  EffectIntentSchema,
  IntentAnswerSchema,
  OutcomeAnswerSchema,
  RecordedOutcomeSchema,
  ReleaseReasonSchema,
  RequestTypes,
  RunGrantSchema,
  RunRoutingSchema,
  TurnOutputSchema,
  TurnStartSchema,
  WorkspaceBytesCallSchema,
  WorkspaceCallSchema,
  WorkspaceListCallSchema,
  WorkspaceRecordSchema,
  WorkspaceSessionSchema,
  coreMessages,
  coreRequests,
  harnessRequests,
} from "./schema.js";

export const HARNESS_API_VERSION = 2;

/** Why core stopped a run. Matches the advance's abort kinds. */
export const ABORT_REASONS = ["cancel", "shutdown", "deadline", "ownership.lost"] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

/** Why a harness gave a run back without an output. */
export type ReleaseReason = z.infer<typeof ReleaseReasonSchema>;

/**
 * Events a harness may claim: for a run it holds, or for a workspace request core sent it. A
 * `sandbox.state` claim carries the workspace's compute record, which core keeps.
 */
export const HARNESS_CLAIMS = ["sandbox.state", "sandbox.exec"] as const;
export type HarnessClaim = (typeof HARNESS_CLAIMS)[number];

export const HARNESS_ERROR_CODES = [
  "run_not_held",
  "turn_cancelled",
  "ownership_lost",
  "effect_drift",
  "invalid",
  "unavailable",
  "internal",
] as const;
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

/** One effect the engine asks for: a `HostEffect`, by structure. Model intents carry no `input`. */
export type EffectIntent = z.infer<typeof EffectIntentSchema>;

/** A completed outcome of the segment, with the hash of the request it answered. */
export type RecordedOutcome = z.infer<typeof RecordedOutcomeSchema>;

/** The lease on one run. `token` is the run token (F5) when the gates require one. */
export type RunGrant = z.infer<typeof RunGrantSchema>;

/** Where a harness sends the session's tool calls. */
export type RunRouting = z.infer<typeof RunRoutingSchema>;

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

/** The session a workspace request acts for: the workspace's owner and its sandbox resource. */
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;

/** A workspace's compute record, as the harness keeps it. */
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/** A sandbox tool call core sends to the harness that serves workspaces. */
export type WorkspaceCall = z.infer<typeof WorkspaceCallSchema>;

/** A file of a workspace read as bytes (`save_artifact`, F8.1), at most `maxBytes`. */
export type WorkspaceBytesCall = z.infer<typeof WorkspaceBytesCallSchema>;

/** The regular files under a directory of a workspace (the turn-end export, F8.2). */
export type WorkspaceListCall = z.infer<typeof WorkspaceListCallSchema>;

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
