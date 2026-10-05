/**
 * What a segment starts from (§10.5): in one transaction the session's state is rebased onto
 * the turn's manifest, a transcript still on the row is recorded, and the segment's completed
 * outcomes are read; then the transcript is folded from the record (P0.3). `buildTurnStart`
 * turns that into the run's `turn.start`: the checkpoint goes without its transcript, which the
 * harness holds at the fold's cursor or reads once.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import type { RecordedOutcome, TurnStart } from "@nylorun/core/harness-api";
import type { DurableCheckpoint, FlowCheckpoint } from "@nylorun/harness/run";
import { isWorkflowManifest } from "../core/flow-host.js";
import { sandboxWorkspaceOf } from "../sandbox/share.js";
import { ownedTx } from "../store/ownership.js";
import type { SandboxPodState, Tx } from "../store/types.js";
import { sandboxLookup, type Lease, type Session, type TenantContext } from "../tenant/context.js";
import {
  checkParity,
  foldTranscriptWithCursor,
  leanState,
  transcriptOf,
  transcriptUpdates,
  withTranscript,
  type TranscriptUpdate,
} from "../tenant/history.js";
import { usesFixtureModel } from "../tenant/model-setting.js";
import { rebaseSessionState, sessionToolsOf, turnManifestOf } from "../tenant/session.js";
import { bulkOutcomes } from "./record.js";

/** Segment rollover defaults (Model Calls §10), well inside the advance deadline. */
const ROLLOVER_STEPS = 50;
const ROLLOVER_MS = 20 * 60_000;

/** A segment ready to run: the session as it starts, and its transcript folded from the record. */
export interface SegmentStart {
  readonly current: Session;
  readonly fixtureModel: boolean;
  /** The transcript the engine resumes from (agents with state; empty otherwise). */
  readonly transcript: unknown[];
  /** The record position of `transcript` (`foldTranscriptWithCursor`). */
  readonly cursor: number;
  readonly outcomes: RecordedOutcome[];
  /** The tree's sandbox workspace: its owning session, and the sandbox resource it is attached to. */
  readonly sandbox: { readonly ownerId: string; readonly sandboxId?: string };
  /** The sandbox is a pod sandbox (F7.2): its engine runs the segment. Its lifecycle state. */
  readonly pod?: { readonly id: string; readonly pod: SandboxPodState };
}

/** The segment's starting transaction and fold. */
export async function startSegment(
  ctx: TenantContext,
  lease: Lease,
  /** For a harness: also the segment's outcomes and the sandbox's owner. */
  options: { harness?: boolean } = {}
): Promise<SegmentStart> {
  const id = lease.sessionId;
  const started = await ownedTx<Omit<SegmentStart, "transcript" | "cursor">, Session>(
    ctx.store,
    id,
    lease.epoch,
    async (t, current) => {
      if (!isWorkflowManifest(current.manifest) && current.checkpoint) {
        rebaseSessionState(current, current.checkpoint.manifestHash);
        await adoptStoredTranscript(t, current);
        const cp = current.checkpoint as DurableCheckpoint;
        current.checkpoint = { ...cp, state: current.state };
        await t.put("sessions", id, current);
      }
      const fixtureModel = await usesFixtureModel(t);
      if (!options.harness) return { current, fixtureModel, outcomes: [], sandbox: { ownerId: id } };
      const sandbox = sandboxWorkspaceOf(current, await sandboxLookup(t, current.id));
      const resource = sandbox.sandboxId === undefined ? undefined : await t.sandboxResource(sandbox.sandboxId);
      return {
        current,
        fixtureModel,
        outcomes: current.checkpoint ? await bulkOutcomes(t, current, current.checkpoint) : [],
        sandbox,
        ...(resource?.pod ? { pod: { id: resource.id, pod: resource.pod } } : {}),
      };
    }
  );
  // One history (P0.3): the engine resumes from the transcript folded from the record.
  const { current } = started;
  const cp = current.checkpoint as DurableCheckpoint | undefined;
  if (isWorkflowManifest(current.manifest) || !cp?.state)
    return { ...started, transcript: [], cursor: -1 };
  const { transcript, cursor } = await foldSession(ctx, current);
  checkParity(id, transcript, transcriptOf(cp.state));
  return { ...started, transcript, cursor };
}

/** The run's `turn.start`. */
export function buildTurnStart(ctx: TenantContext, segment: SegmentStart): TurnStart {
  const { current } = segment;
  const flow = isWorkflowManifest(current.manifest);
  const cp = current.checkpoint as DurableCheckpoint | FlowCheckpoint;
  const input = (cp as { input?: { kind?: unknown } }).input;
  return {
    type: !flow && (input?.kind === "approve" || input?.kind === "respond") ? "approval.answer" : "turn.start",
    engine: flow ? "flow" : "agent",
    manifest: flow ? current.manifest : turnManifestOf(current),
    checkpoint:
      !flow && (cp as DurableCheckpoint).state
        ? { ...cp, state: withTranscript((cp as DurableCheckpoint).state, []) }
        : cp,
    ...(flow ? {} : { sessionTools: sessionToolsOf(current.mcpSnapshot, current.manifest) ?? [] }),
    outcomes: segment.outcomes,
    transcript: { cursor: segment.cursor },
    options: {
      ...(flow
        ? { flowLimits: ctx.flowLimits }
        : { yieldAfter: yieldAfterOf(ctx) }),
      fixtureModel: segment.fixtureModel,
    },
    routing: {
      rootManifest: current.manifest,
      ...(current.mcpSnapshot ? { mcpSnapshot: current.mcpSnapshot } : {}),
      sandbox: segment.sandbox,
    },
  };
}

/** The engine's yield budget for a segment. */
export function yieldAfterOf(ctx: TenantContext): { steps: number; ms: number } {
  return {
    steps: ctx.config.rollover?.steps ?? ROLLOVER_STEPS,
    ms: ctx.config.rollover?.ms ?? ROLLOVER_MS,
  };
}

/**
 * A session written before transcripts were recorded keeps its transcript on its row: record
 * it once (the turn's starting transcript, then the turn so far), and store the row lean.
 */
async function adoptStoredTranscript(t: Tx, s: Session): Promise<void> {
  if (s.history) return;
  const now = transcriptOf(s.state);
  const start = s.activeTurnId ? transcriptOf(s.turnStartState) : now;
  if (now.length === 0 && start.length === 0) return;
  let first: number | undefined;
  const write = async (turnId: string | null, updates: TranscriptUpdate[]) => {
    for (const update of updates) {
      const event = await t.event(s.id, turnId, "transcript.updated", update);
      first ??= event.seq;
    }
  };
  await write(null, transcriptUpdates([], start));
  if (s.activeTurnId) await write(s.activeTurnId, transcriptUpdates(start, now));
  s.history = { from: first ?? 0, snapshot: first ?? 0 };
  s.state = leanState(s.state);
  s.turnStartState = leanState(s.turnStartState);
}

/** The session's transcript, folded from its record from `history.from`, and its cursor. */
async function foldSession(
  ctx: TenantContext,
  s: Session
): Promise<{ transcript: unknown[]; cursor: number }> {
  const rows = await ctx.store
    .record()
    .readRange(ctx.store.tenantId, s.id, s.history?.from ?? 0, Number.MAX_SAFE_INTEGER);
  return foldTranscriptWithCursor(rows.map((row) => row.body as LiveEvent));
}
