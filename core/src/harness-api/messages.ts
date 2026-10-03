/**
 * Harness API v1 (blueprint D37–D42): the messages between core and a harness. A run is a
 * lease on one session's segment; core records, the harness runs the engine. Who executes what:
 * the harness runs model, MCP and sandbox calls; core runs Actions, hooks, flow work, linked
 * sessions, delegation journaling, settle and takeover.
 */
import type { ActionOutcome } from "../contracts.js";
import type { AgentRef } from "../types/tool.js";
import type { TranscriptUpdate } from "./transcript.js";

export const HARNESS_API_VERSION = 1;

/** Why core stopped a run. Matches the advance's abort kinds. */
export type AbortReason = "cancel" | "shutdown" | "deadline" | "ownership.lost";
export const ABORT_REASONS: readonly AbortReason[] = [
  "cancel",
  "shutdown",
  "deadline",
  "ownership.lost",
];

/** Why a harness gave a run back without an output. */
export type ReleaseReason = "shutdown" | "ownership.lost" | "connection.lost";

/** Events a harness may claim for a run it holds. */
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
export interface EffectIntent {
  readonly effectId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly manifestHash: string;
  readonly kind: "model" | "tool" | "hook" | "delegation" | "agent" | "fn" | "verify";
  readonly agent?: AgentRef;
  readonly capabilityId?: string;
  readonly toolName?: string;
  readonly hook?: {
    readonly at: "before" | "after";
    readonly scope: "turn" | "step";
    readonly capabilityIds: readonly string[];
  };
  readonly path?: string;
  readonly key?: string;
  readonly iterations?: string;
  readonly input?: unknown;
  readonly context: Record<string, unknown>;
}

/** A completed outcome of the segment, with the hash of the request it answered. */
export interface RecordedOutcome {
  readonly effectId: string;
  readonly requestHash: string;
  readonly outcome: ActionOutcome;
}

/** The lease on one run. `token` is the run token (F5) when the gates require one. */
export interface RunGrant {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly token?: string;
  readonly tokenExpiresAt?: string;
}

/** Where a harness sends the session's tool calls. */
export interface RunRouting {
  /** The session's pinned manifest: an effect's agent resolves against it. */
  readonly rootManifest: unknown;
  readonly pluginRoots: Readonly<Record<string, string>>;
  readonly mcpSnapshot?: unknown;
  /** The session that owns the tree's sandbox, and the sandbox resource it is attached to. */
  readonly sandbox?: { readonly ownerId: string; readonly sandboxId?: string; readonly spec?: unknown };
}

/** What a run starts from: `turn.start` (message, continue, resume) or `approval.answer`. */
export interface TurnStart {
  readonly type: "turn.start" | "approval.answer";
  readonly engine: "agent" | "flow";
  /** The turn's manifest (agent) or the workflow manifest (flow). */
  readonly manifest: unknown;
  /** The segment's checkpoint; an agent's state has no transcript (`transcript.cursor`). */
  readonly checkpoint: unknown;
  readonly sessionTools?: readonly unknown[];
  /** Completed outcomes of this segment, resolved without asking core. */
  readonly outcomes: readonly RecordedOutcome[];
  /** The record position the session's transcript was folded at. */
  readonly transcript: { readonly cursor: number };
  readonly options: {
    readonly yieldAfter?: { readonly steps?: number; readonly ms?: number };
    readonly flowLimits?: unknown;
    readonly fixtureModel: boolean;
  };
  readonly routing: RunRouting;
}

/** How a segment ended, as the harness reports it. */
export type TurnStatus =
  | "completed"
  | "paused"
  | "yielded"
  | "waiting"
  | "uncertain"
  | "failed"
  | "cancelled";

/**
 * A segment's end. `state` is the agent's engine state without its transcript; `transcript`
 * edits the transcript the segment started from. `thrown` reports an engine that threw.
 */
export interface TurnOutput {
  readonly runId: string;
  readonly status?: TurnStatus;
  readonly state?: unknown;
  readonly output?: unknown;
  readonly pending?: unknown;
  readonly error?: unknown;
  readonly effectIds?: readonly string[];
  readonly cancelEffectIds?: readonly string[];
  readonly transcript?: readonly TranscriptUpdate[];
  readonly thrown?: { readonly code?: string; readonly message: string };
}

export type OutputMethod = "turn.completed" | "turn.paused" | "turn.waiting" | "turn.failed" | "checkpoint";

export type IntentAnswer =
  | { readonly status: "completed"; readonly outcome: ActionOutcome }
  | { readonly status: "pending" | "uncertain" }
  | { readonly status: "execute"; readonly rejoin?: true };

export type OutcomeAnswer =
  | { readonly status: "completed"; readonly outcome: ActionOutcome }
  | { readonly status: "uncertain" };

/** Requests a harness sends to core, with their answers. */
export interface HarnessRequests {
  hello: {
    params: {
      api: number;
      name: string;
      version: string;
      capabilities: { workspace?: unknown };
    };
    result: { api: number; sandbox: { backend: string | null }; renewEveryMs: number };
  };
  lease: {
    params: { slots?: number };
    result: { run: RunGrant; input: TurnStart };
  };
  "lease.renew": {
    params: { runId: string };
    result: { ok: true; token?: string; tokenExpiresAt?: string } | { ok: false };
  };
  "lease.release": {
    params: { runId: string; reason: ReleaseReason };
    result: Record<string, never>;
  };
  "effect.intent": {
    params: { runId: string; effect: EffectIntent; requestHash: string };
    result: IntentAnswer;
  };
  "effect.outcome": {
    params:
      | { runId: string; effectId: string; value: unknown }
      | { runId: string; effectId: string; error: string };
    result: OutcomeAnswer;
  };
  "transcript.read": {
    params: { runId: string };
    result: { cursor: number; entries: unknown[] };
  };
  event: {
    params: {
      runId?: string;
      sessionId: string;
      turnId: string | null;
      type: HarnessClaim;
      payload: unknown;
    };
    result: Record<string, never>;
  };
  "session.mcp": {
    params: { runId: string; snapshot?: unknown; diagnostics: unknown[] };
    result: { snapshot: unknown; sessionTools: unknown[] };
  };
  "turn.completed": { params: TurnOutput; result: { cursor?: number } };
  "turn.paused": { params: TurnOutput; result: { cursor?: number } };
  "turn.waiting": { params: TurnOutput; result: { cursor?: number } };
  "turn.failed": { params: TurnOutput; result: { cursor?: number } };
  /** A yielded segment's state: ends the run, the turn goes on in the next. */
  checkpoint: { params: TurnOutput; result: { cursor?: number } };
}

/** Messages core sends to a harness, without an answer. */
export interface CoreMessages {
  /** `message` is core's abort message, which the run's executors see as theirs. */
  cancel: { runId: string; reason: AbortReason; message?: string };
  /** F6.2: an Action's outcome for a run held while it is pending. */
  "effect.resolved": { runId: string; effectId: string; outcome: ActionOutcome };
}

export type HarnessMethod = keyof HarnessRequests;
export type CoreMessage = keyof CoreMessages;
export type ParamsOf<M extends HarnessMethod> = HarnessRequests[M]["params"];
export type ResultOf<M extends HarnessMethod> = HarnessRequests[M]["result"];
