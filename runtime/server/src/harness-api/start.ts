/**
 * What a segment starts from (§10.5): in one transaction the session's state is rebased onto
 * the turn's manifest, a transcript still on the row is recorded, and the segment's completed
 * outcomes are read; then the transcript is folded from the record (P0.3). `buildTurnStart`
 * turns that into the run's `turn.start`: the checkpoint goes without its transcript, which the
 * harness holds at the fold's cursor or reads once.
 */
import { harnessLimitsOf, type LiveEvent } from "@nylorun/core/contracts";
import type {
  ModelDescriptor,
  RecordedOutcome,
  RuntimeLimits,
  TurnAgent,
  TurnStart,
} from "@nylorun/core/harness-api";
import { SANDBOX_WORKSPACE, type SandboxManifest } from "@nylorun/core/define";
import type { DurableCheckpoint, FlowCheckpoint } from "@nylorun/harness/run";
import { isWorkflowManifest } from "../core/flow-host.js";
import { sandboxWorkspaceOf } from "../sandbox/share.js";
import { ownedTx } from "../store/ownership.js";
import type { SandboxPodState, Tx } from "../store/types.js";
import { harnessOf, type Lease, type Session, type TenantContext } from "../tenant/context.js";
import { repinTurn } from "../tenant/agent-versions.js";
import { HARNESS_ID } from "../sandbox/placement.js";
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
import { currentModelDescriptor } from "../model/descriptor.js";
import { readRuntimeLimits } from "../tenant/runtime-limits.js";
import { flowLimitsOf } from "../core/limits.js";
import { turnManifestOf } from "../tenant/session.js";
import { mcpFactsOf } from "../mcp/snapshot.js";
import { bulkOutcomes } from "./record.js";
import { traceKey } from "../traces/key.js";
import { hostTuning } from "../tuning.js";
import {
  traceparentOf,
  turnSpanOf,
  turnTraceIdOf,
  type TraceContext,
  type TraceKey,
} from "../traces/ids.js";

/** A segment ready to run: the session as it starts, and its transcript folded from the record. */
export interface SegmentStart {
  readonly current: Session;
  readonly fixtureModel: boolean;
  /** The Tenant's Runtime limits as the segment starts: what `turn.start.limits` hands the harness. */
  readonly limits: RuntimeLimits;
  /** The transcript the engine resumes from (agents with state; empty otherwise). */
  readonly transcript: unknown[];
  /** The record position of `transcript` (`foldTranscriptWithCursor`). */
  readonly cursor: number;
  readonly outcomes: RecordedOutcome[];
  /** The session's sandbox workspace: the session, and the Agent whose workspace it is. */
  readonly sandbox: {
    readonly ownerId: string;
    readonly environmentId?: string;
    /** Variables every sandbox command gets (R2c): secret names set to the sentinel, plain values. */
    readonly environment?: Readonly<Record<string, string>>;
    /** The sandbox spec the session pinned when it opened; absent without a sandbox. */
    readonly spec?: SandboxManifest;
  };
  /**
   * The Agent the session runs on, as `TurnStart.agent` states it (Harness API 5): its id and
   * kind, and its sandbox's workspace when the session has a sandbox.
   */
  readonly agent?: TurnAgent;
  /**
   * The Agent is a pod (F7.2): its engine runs the segment. Its lifecycle state, and whether its
   * new volume is still being seeded from a disk version (R2d step 3).
   */
  readonly pod?: { readonly id: string; readonly pod: SandboxPodState; readonly seeding?: boolean };
  /** The turn's span context (R7.4): what `TurnStart.trace` hands the harness. */
  readonly trace?: TraceContext;
  /**
   * The model the turn's calls use (protocol 15), as the segment starts: what `TurnStart.model`
   * hands an agent's harness. Absent for a flow, and when the Tenant has no model.
   */
  readonly model?: ModelDescriptor;
}

/** The segment's starting transaction and fold. */
export async function startSegment(
  ctx: TenantContext,
  lease: Lease,
  /** For a harness: also the segment's outcomes and the sandbox's owner. */
  options: { harness?: boolean } = {}
): Promise<SegmentStart> {
  const id = lease.sessionId;
  // Read before the transaction: the first read of the Tenant may create the key.
  const key = options.harness ? await traceKey(ctx.store) : undefined;
  const opened = await ownedTx<Omit<SegmentStart, "transcript" | "cursor" | "model">, Session>(
    ctx.store,
    id,
    lease.epoch,
    async (t, current) => {
      // A turn's first segment runs the version its Agent runs now (T3, D73).
      if (options.harness && (await repinTurn(t, current))) await t.put("sessions", id, current);
      // A transcript left on our engine's state by an older Runtime is recorded once; another
      // harness's state is its own (R4.2).
      const limits = await readRuntimeLimits(t);
      if (!isWorkflowManifest(current.manifest) && current.checkpoint && harnessOf(current) === HARNESS_ID) {
        await adoptStoredTranscript(t, current, limits.recordEntryBytes);
        const cp = current.checkpoint as DurableCheckpoint;
        current.checkpoint = { ...cp, state: current.state };
        await t.put("sessions", id, current);
      }
      const fixtureModel = await usesFixtureModel(t);
      if (!options.harness) return { current, fixtureModel, limits, outcomes: [], sandbox: { ownerId: id } };
      const workspace = sandboxWorkspaceOf(current);
      const resource = workspace.environmentId === undefined ? undefined : await t.environment(workspace.environmentId);
      const environment = await ctx.vault.environmentVariables(t, current.environmentId);
      const sandbox = {
        ...workspace,
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
        ...(current.sandbox === undefined ? {} : { spec: current.sandbox }),
      };
      const turnId = current.activeTurnId;
      return {
        current,
        fixtureModel,
        limits,
        outcomes: current.checkpoint ? await bulkOutcomes(t, current, current.checkpoint) : [],
        sandbox,
        ...(resource ? { agent: agentOf(resource, current.sandbox) } : {}),
        ...(key && turnId ? { trace: turnContextOf(key, ctx.store.tenantId, current, turnId) } : {}),
        ...(resource?.pod
          ? { pod: { id: resource.id, pod: resource.pod, ...(resource.diskSeed ? { seeding: true } : {}) } }
          : {}),
      };
    }
  );
  // The model an agent's harness decides files by, read outside the session's transaction.
  const model =
    options.harness && !isWorkflowManifest(opened.current.manifest)
      ? await currentModelDescriptor(ctx)
      : undefined;
  const started = model ? { ...opened, model } : opened;
  // One history (P0.3): the engine resumes from the transcript folded from the record.
  const { current } = started;
  const cp = current.checkpoint as DurableCheckpoint | undefined;
  if (isWorkflowManifest(current.manifest)) return { ...started, transcript: [], cursor: -1 };
  // Another harness's state says nothing about its transcript (R4.2): fold it every segment.
  if (harnessOf(current) !== HARNESS_ID) {
    const { transcript, cursor } = await foldSession(ctx, current);
    return { ...started, transcript, cursor };
  }
  if (!cp?.state) return { ...started, transcript: [], cursor: -1 };
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
      !flow && (cp as DurableCheckpoint).state && harnessOf(current) === HARNESS_ID
        ? { ...cp, state: withTranscript((cp as DurableCheckpoint).state, []) }
        : cp,
    // The session's MCP discovery as the turn's manifest sees it: a variant may disable tools.
    ...(!flow && current.mcpSnapshot ? { mcp: mcpFactsOf(current.mcpSnapshot, turnManifestOf(current)) } : {}),
    outcomes: segment.outcomes,
    transcript: { cursor: segment.cursor },
    options: {
      ...(flow
        ? { flowLimits: flowLimitsOf(segment.limits) }
        : { yieldAfter: yieldAfterOf(ctx) }),
      fixtureModel: segment.fixtureModel,
    },
    routing: {
      rootManifest: current.manifest,
      sandbox: segment.sandbox,
    },
    ...(segment.trace ? { trace: segment.trace } : {}),
    limits: harnessLimitsOf(segment.limits),
    ...(segment.model && !flow ? { model: segment.model } : {}),
    ...(segment.agent && !flow ? { agent: segment.agent } : {}),
    // The agent manifest version the session pinned, and its harness's own settings (protocol 16).
    ...(current.definition === undefined ? {} : { definition: current.definition }),
    ...(current.loop === undefined || flow ? {} : { loop: current.loop }),
  };
}

/**
 * The facts of the Agent a session runs on (Harness API 5): its id and kind, and, with the
 * session's sandbox, the workspace its commands start in. The harness words them.
 */
function agentOf(
  resource: { readonly id: string; readonly kind: TurnAgent["kind"] },
  spec: SandboxManifest | undefined,
): TurnAgent {
  return {
    id: resource.id,
    kind: resource.kind,
    ...(spec === undefined ? {} : { sandbox: { workspace: SANDBOX_WORKSPACE } }),
  };
}

/**
 * The context of turn `turnId`'s span (R7.4): its trace (the caller's when its message carried a
 * `traceparent`) and its span, as the trace projector derives them, with the caller's
 * `tracestate`.
 */
function turnContextOf(
  key: TraceKey,
  tenantId: string,
  s: Pick<Session, "id" | "turnTrace">,
  turnId: string,
): TraceContext {
  const traceId = turnTraceIdOf(key, { tenantId, sessionId: s.id, turnId }, s.turnTrace);
  return {
    traceparent: traceparentOf(traceId, turnSpanOf(key, turnId)),
    ...(s.turnTrace?.tracestate ? { tracestate: s.turnTrace.tracestate } : {}),
  };
}

/**
 * The engine's yield budget for a segment: the Tenant's `rollover`, else the Host tuning's
 * (`harnessApi.rolloverSteps`, `rolloverMs`), well inside the advance deadline.
 */
export function yieldAfterOf(ctx: TenantContext): { steps: number; ms: number } {
  return {
    steps: ctx.config.rollover?.steps ?? hostTuning().harnessApi.rolloverSteps,
    ms: ctx.config.rollover?.ms ?? hostTuning().harnessApi.rolloverMs,
  };
}

/**
 * A session written before transcripts were recorded keeps its transcript on its row: record
 * it once (the turn's starting transcript, then the turn so far), and store the row lean.
 */
async function adoptStoredTranscript(t: Tx, s: Session, recordEntryBytes: number): Promise<void> {
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
  await write(null, transcriptUpdates([], start, recordEntryBytes));
  if (s.activeTurnId) await write(s.activeTurnId, transcriptUpdates(start, now, recordEntryBytes));
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
