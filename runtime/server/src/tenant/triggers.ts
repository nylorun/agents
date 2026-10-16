/**
 * Triggers (track T4, D74): what starts an Agent's turns with no client connected.
 *
 * An agent manifest declares them in `runtime.triggers`; whether each one is on and when it fires
 * next is the Agent's, in `agent_triggers`. Postgres holds that truth, and one durable timer per
 * active trigger (`ctx.timer`, `DurableExecution.timer`, keyed `trigger:<agentId>:<triggerId>`)
 * wakes it:
 *
 * 1. **Arm.** A trigger's next time is written to its row, and its timer is armed for it after the
 *    commit, at most `TIMER_MAX_MS` ahead: a longer wait is armed in steps, and a step that fires
 *    early only arms the next one. The timer keeps the latest time per key.
 * 2. **Fire.** `fireTimer` locks the row and does nothing unless it is active and due. It records
 *    the run (`deliverRun`), computes the next time from `max(now, due)` and arms it. There is only
 *    ever one timer per trigger, so after downtime it fires once, marked `late` when more than
 *    `triggers.lateGraceMs` (Host tuning) past due, and never backfills.
 * 3. **Reconcile.** The Tenant sweep arms every active trigger on its first pass on this process
 *    (an in-process execution's timers die with it), and overdue ones on every pass after: a lost
 *    Restate, a crash between commit and arm.
 *
 * Every way a trigger runs ends in `deliverRun`, in one transaction with the trigger's row and the
 * session locked: the run row (`trigger_runs`, keyed by its cause, so a repeated fire, delivery or
 * request makes one run), the Tenant's `triggerRunsPerHour`, the busy-schedule rule (a schedule or
 * `at` trigger adds at most one queued message to its session; later fires are skipped, `overlap`),
 * then the session queue's door (`acceptMessage`): a turn, or a queued message.
 *
 * A schedule's runs are moved by a fixed offset (jitter), from a hash of the Agent and trigger id:
 * up to `triggerJitterPercent` of its interval and `triggerJitterMaxMs`.
 */
import { createHash, randomBytes } from "node:crypto";
import { Cron } from "croner";
import {
  TIMER_MAX_MS,
  triggerKindOf,
  type AgentManifestV8,
  type EventWriter,
  type RuntimeLimits,
  type Trigger,
  type TriggerKind,
  type TriggerRun,
  type TriggerView,
} from "@nylorun/core/contracts";
import type { AgentTriggerRow, Environment, TriggerRunRow, Tx } from "../store/types.js";
import { hostTuning } from "../tuning.js";
import type { Session, TenantContext } from "./context.js";
import { checkAgentTurn, liveEnvironment } from "./agents.js";
import { acceptMessage, QUEUE_SCOPE, takesMessages, type MessageCause, type TurnMessage } from "./commands.js";
import { fail, HttpError } from "./http.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { openSessionIn } from "./sessions.js";

const TIMER_PREFIX = "trigger:";
const HOUR_MS = 3_600_000;

/** The durable timer key of an Agent's trigger. Agent ids hold no `:`. */
export const triggerTimerKey = (agentId: string, triggerId: string) => `${TIMER_PREFIX}${agentId}:${triggerId}`;

function parseTimerKey(key: string): { agentId: string; triggerId: string } | undefined {
  if (!key.startsWith(TIMER_PREFIX)) return undefined;
  const rest = key.slice(TIMER_PREFIX.length);
  const at = rest.indexOf(":");
  return at <= 0 ? undefined : { agentId: rest.slice(0, at), triggerId: rest.slice(at + 1) };
}

/** A new run id: increasing with time, so runs list newest first by id. */
export function newRunId(now = Date.now()): string {
  return `run_${now.toString(36).padStart(9, "0")}${randomBytes(8).toString("hex")}`;
}

/** A schedule's cron in its time zone (UTC by default); throws on a bad pattern or zone. */
export function cronOf(trigger: Pick<Trigger, "schedule" | "timezone">): Cron {
  return new Cron(trigger.schedule!, { timezone: trigger.timezone ?? "UTC", paused: true });
}

/**
 * The fixed offset of a schedule's runs: from a hash of the Agent and trigger id, at most
 * `triggerJitterPercent` of its interval and `triggerJitterMaxMs`, so a fleet of hourly Agents
 * spreads out and none of them drifts.
 */
export function jitterMs(agentId: string, triggerId: string, intervalMs: number, limits: RuntimeLimits): number {
  const cap = Math.min(Math.floor((intervalMs * limits.triggerJitterPercent) / 100), limits.triggerJitterMaxMs);
  if (cap <= 0) return 0;
  const fraction = createHash("sha256").update(`${agentId}\u0000${triggerId}`).digest().readUInt32BE(0) / 2 ** 32;
  return Math.floor(fraction * cap);
}

/**
 * When trigger `trigger` of Agent `agentId` fires next after `after`, or `null` when it never
 * does again (an `at` that passed, a webhook).
 */
export function nextFireAt(agentId: string, triggerId: string, trigger: Trigger, after: Date, limits: RuntimeLimits): Date | null {
  if (trigger.at !== undefined) {
    const at = new Date(trigger.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  if (trigger.schedule === undefined) return null;
  const cron = cronOf(trigger);
  // The interval near now decides the offset; it never changes for a fixed cron and zone in
  // practice, and a shorter one only moves runs less.
  const [first, second] = cron.nextRuns(2, after);
  if (!first) return null;
  const jitter = second ? jitterMs(agentId, triggerId, second.getTime() - first.getTime(), limits) : 0;
  // The next cron time whose shifted time is after `after`.
  const base = cron.nextRun(new Date(after.getTime() - jitter));
  return base ? new Date(base.getTime() + jitter) : null;
}

/**
 * Why `triggers` cannot be saved (D74): more than `triggersPerAgent`, a cron or time zone croner
 * refuses, two runs closer than `triggerMinIntervalMs` over the next `triggers.intervalCheckFires`
 * fires, an `at` that is not in the future, a prompt past `triggerPromptChars`.
 */
export function triggerIssues(
  triggers: Readonly<Record<string, Trigger>> | undefined,
  limits: RuntimeLimits,
  now = new Date(),
): string[] {
  if (!triggers) return [];
  const issues: string[] = [];
  const ids = Object.keys(triggers);
  if (ids.length > limits.triggersPerAgent)
    issues.push(
      `runtime.triggers declares ${ids.length} triggers, over the Runtime limit triggersPerAgent (${limits.triggersPerAgent}; PUT /v1/tenant/limits).`,
    );
  const fires = hostTuning().triggers.intervalCheckFires;
  for (const [id, trigger] of Object.entries(triggers)) {
    const at = `runtime.triggers.${id}`;
    if (trigger.prompt.length > limits.triggerPromptChars)
      issues.push(
        `${at}.prompt is ${trigger.prompt.length} characters, over the Runtime limit triggerPromptChars (${limits.triggerPromptChars}).`,
      );
    if (trigger.at !== undefined && Date.parse(trigger.at) <= now.getTime())
      issues.push(`${at}.at (${trigger.at}) is not in the future.`);
    if (trigger.schedule === undefined) continue;
    let runs: Date[];
    try {
      runs = cronOf(trigger).nextRuns(fires, now);
    } catch (error) {
      issues.push(`${at}: ${error instanceof Error ? error.message : String(error)}.`);
      continue;
    }
    if (runs.length === 0) {
      issues.push(`${at}.schedule (${trigger.schedule}) never runs.`);
      continue;
    }
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i]!.getTime() - runs[i - 1]!.getTime());
    if (gap < limits.triggerMinIntervalMs)
      issues.push(
        `${at}.schedule (${trigger.schedule}) runs ${gap} ms apart, under the Runtime limit triggerMinIntervalMs (${limits.triggerMinIntervalMs} ms; PUT /v1/tenant/limits).`,
      );
  }
  return issues;
}

/** The triggers of the manifest version an Agent runs. */
async function triggersOf(t: Tx, agent: Environment): Promise<Record<string, Trigger>> {
  const version = await t.agentManifest(agent.manifestName, agent.manifestVersion);
  return ((version?.body as AgentManifestV8 | undefined)?.runtime?.triggers ?? {}) as Record<string, Trigger>;
}

/**
 * Writes the state of a new Agent's triggers (D74): every trigger of the version it is made from
 * starts active, with its next time. Arm them after the commit (`armAgentTriggers`).
 */
export async function createAgentTriggers(t: Tx, agent: Environment, now = new Date()): Promise<void> {
  const limits = await readRuntimeLimits(t);
  const stamp = now.toISOString();
  for (const [triggerId, trigger] of Object.entries(await triggersOf(t, agent))) {
    const next = nextFireAt(agent.id, triggerId, trigger, now, limits);
    await t.putAgentTrigger({
      agentId: agent.id,
      triggerId,
      kind: triggerKindOf(trigger),
      status: "active",
      pausedReason: null,
      generation: 0,
      nextFireAt: next?.toISOString() ?? null,
      lastFireAt: null,
      endpointId: null,
      sealedSecret: null,
      sessionId: null,
      note: null,
      effectId: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
}

/**
 * After Agent `agent` (locked) moved from manifest version `from` to the version it now runs (track
 * T3, D73), in the move's transaction: its triggers merge by id. One the new version adds arrives
 * paused (`new`), one it drops loses its state (its runs stay), and one whose timing changed gets a
 * new generation and next time; a changed prompt or session applies at the next fire. The sweep
 * arms what changed (`reconcileTriggers`).
 */
export async function mergeAgentTriggers(t: Tx, agent: Environment, from: number, now = new Date()): Promise<void> {
  const before = (((await t.agentManifest(agent.manifestName, from))?.body as AgentManifestV8 | undefined)?.runtime?.triggers ??
    {}) as Record<string, Trigger>;
  const after = await triggersOf(t, agent);
  const limits = await readRuntimeLimits(t);
  const stamp = now.toISOString();
  const rows = new Map((await t.agentTriggers(agent.id)).map((row) => [row.triggerId, row]));
  for (const [triggerId, row] of rows)
    if (row.kind !== "wake" && after[triggerId] === undefined) await t.deleteAgentTrigger(agent.id, triggerId);
  const timing = (trigger: Trigger | undefined) =>
    trigger === undefined ? undefined : JSON.stringify([trigger.schedule, trigger.timezone, trigger.at, trigger.webhook]);
  for (const [triggerId, trigger] of Object.entries(after)) {
    const row = rows.get(triggerId);
    if (!row) {
      await t.putAgentTrigger({
        agentId: agent.id,
        triggerId,
        kind: triggerKindOf(trigger),
        status: "paused",
        pausedReason: "new",
        generation: 0,
        nextFireAt: null,
        lastFireAt: null,
        endpointId: null,
        sealedSecret: null,
        sessionId: null,
        note: null,
        effectId: null,
        createdAt: stamp,
        updatedAt: stamp,
      });
      continue;
    }
    if (timing(before[triggerId]) === timing(trigger) && row.kind === triggerKindOf(trigger)) continue;
    const next = row.status === "active" ? nextFireAt(agent.id, triggerId, trigger, now, limits) : null;
    await t.putAgentTrigger({
      ...row,
      kind: triggerKindOf(trigger),
      generation: row.generation + 1,
      nextFireAt: next?.toISOString() ?? null,
      updatedAt: stamp,
    });
  }
}

/** Arms one trigger's timer for its next time, or the next step of a wait past `TIMER_MAX_MS`. */
export async function armTrigger(ctx: TenantContext, row: Pick<AgentTriggerRow, "agentId" | "triggerId" | "status" | "nextFireAt">): Promise<void> {
  if (row.status !== "active" || row.nextFireAt === null) return;
  const at = Math.min(Date.parse(row.nextFireAt), Date.now() + TIMER_MAX_MS);
  await ctx.timer(triggerTimerKey(row.agentId, row.triggerId), new Date(at));
}

/** Arms every active trigger of Agent `agentId`, after the commit that changed them. */
export async function armAgentTriggers(ctx: TenantContext, agentId: string): Promise<void> {
  for (const row of await ctx.store.tx((t) => t.agentTriggers(agentId))) await armTrigger(ctx, row);
}

/**
 * The Tenant sweep's step (see the module comment): every active trigger on the first pass on
 * this process, overdue ones after; and runs past `triggerRunRetentionMs` are deleted.
 */
export async function reconcileTriggers(ctx: TenantContext, first: boolean): Promise<void> {
  const started = new Date().toISOString();
  const since = lastReconcile.get(ctx);
  const { lateGraceMs } = hostTuning().triggers;
  await armEach(ctx, first || since === undefined ? {} : { dueBefore: new Date(Date.now() - lateGraceMs).toISOString() });
  // Triggers a move changed (`mergeAgentTriggers`) since the last pass, armed for their new time.
  if (!first && since !== undefined) await armEach(ctx, { changedSince: since });
  lastReconcile.set(ctx, started);
  await ctx.store.tx(async (t) => {
    const { triggerRunRetentionMs } = await readRuntimeLimits(t);
    await t.pruneTriggerRuns(new Date(Date.now() - triggerRunRetentionMs).toISOString());
  });
}

/** When each open Tenant's last reconcile on this process started. */
const lastReconcile = new WeakMap<TenantContext, string>();

/** Arms every active trigger the filter selects, page by page. */
async function armEach(ctx: TenantContext, filter: { dueBefore?: string; changedSince?: string }): Promise<void> {
  const { batchSize } = hostTuning().sweep;
  let after: { agentId: string; triggerId: string } | undefined;
  for (;;) {
    const rows = await ctx.store.tx((t) => t.activeTriggers({ ...filter, ...(after ? { after } : {}), limit: batchSize }));
    for (const row of rows) await armTrigger(ctx, row);
    if (rows.length < batchSize) break;
    const last = rows.at(-1)!;
    after = { agentId: last.agentId, triggerId: last.triggerId };
  }
}

/** `DurableExecution.timer` fired for key `key` (`TenantWorker.fire`). */
export async function fireTimer(ctx: TenantContext, key: string): Promise<void> {
  const target = parseTimerKey(key);
  if (!target) return;
  const { agentId, triggerId } = target;
  const armed = await ctx.store.tx(async (t) => {
    const row = await t.agentTrigger(agentId, triggerId, { lock: true });
    if (!row || row.status !== "active" || row.nextFireAt === null) return undefined;
    const due = Date.parse(row.nextFireAt);
    const now = Date.now();
    // A step of a long wait, or a timer armed for an older time: arm again for this one.
    if (due > now) return row;
    const agent = await liveEnvironment(t, agentId, { lock: true });
    if (!agent) return undefined;
    const trigger = (await triggersOf(t, agent))[triggerId];
    if (!trigger) {
      await t.deleteAgentTrigger(agentId, triggerId);
      return undefined;
    }
    await deliverRun(ctx, t, agent, triggerId, trigger, row, {
      runKey: `fire:${triggerId}:${due}`,
      dueAt: row.nextFireAt,
      late: now - due > hostTuning().triggers.lateGraceMs,
    });
    const limits = await readRuntimeLimits(t);
    // An `at` runs once: then it is completed.
    const next = row.kind === "at" ? null : nextFireAt(agentId, triggerId, trigger, new Date(Math.max(now, due)), limits);
    const stamp = new Date(now).toISOString();
    const updated: AgentTriggerRow = {
      ...row,
      lastFireAt: stamp,
      updatedAt: stamp,
      nextFireAt: next?.toISOString() ?? null,
      ...(next === null && row.kind === "at" ? { status: "completed" as const } : {}),
    };
    await t.putAgentTrigger(updated);
    return updated;
  });
  if (armed) await armTrigger(ctx, armed);
}

/** What makes a run: its cause's key, when it was due, whether late. */
interface RunCause {
  runKey: string;
  dueAt: string;
  late: boolean;
}

/** Who writes a triggered message: core, for the trigger (R4.9). */
const triggerWriter = (triggerId: string): EventWriter => ({
  source: { kind: "core", id: "runtime" },
  principal: { kind: "trigger", id: triggerId },
});

/**
 * Runs trigger `triggerId` of `agent` (locked, with the trigger's row) in `t`: see the module
 * comment. Returns the run; a cause already run returns that run.
 */
export async function deliverRun(
  ctx: TenantContext,
  t: Tx,
  agent: Environment,
  triggerId: string,
  trigger: Trigger,
  row: Pick<AgentTriggerRow, "kind">,
  cause: RunCause,
): Promise<TriggerRunRow> {
  const existing = await t.triggerRunByKey(agent.id, cause.runKey);
  if (existing) return existing;
  const firedAt = new Date().toISOString();
  const id = newRunId();
  const run: TriggerRunRow = {
    id,
    agentId: agent.id,
    triggerId,
    kind: row.kind,
    runKey: cause.runKey,
    dueAt: cause.dueAt,
    firedAt,
    late: cause.late,
    status: "skipped",
    reason: null,
    sessionId: null,
    turnId: null,
    queuedMessageId: null,
  };
  const outcome = await runOutcome(ctx, t, agent, triggerId, trigger, row.kind, id, firedAt);
  Object.assign(run, outcome);
  await t.insertTriggerRun(run);
  await t.agentEvent(agent.id, "agent.run", {
    runId: id,
    triggerId,
    dueAt: run.dueAt,
    late: run.late,
    status: run.status,
    ...(run.reason === null ? {} : { reason: run.reason }),
    ...(run.sessionId === null ? {} : { sessionId: run.sessionId }),
  });
  return run;
}

type Outcome = Pick<TriggerRunRow, "status" | "reason" | "sessionId" | "turnId" | "queuedMessageId">;

async function runOutcome(
  ctx: TenantContext,
  t: Tx,
  agent: Environment,
  triggerId: string,
  trigger: Trigger,
  kind: TriggerKind,
  runId: string,
  firedAt: string,
): Promise<Partial<Outcome>> {
  const skipped = (reason: string, sessionId: string | null = null): Partial<Outcome> => ({ status: "skipped", reason, sessionId });
  const failed = (reason: string, sessionId: string | null = null): Partial<Outcome> => ({ status: "failed", reason, sessionId });
  if (agent.desiredState === "off") return skipped("paused");
  const limits = await readRuntimeLimits(t);
  const hourAgo = new Date(Date.parse(firedAt) - HOUR_MS).toISOString();
  if ((await t.countTriggerRuns(agent.id, hourAgo, ["started", "queued"])) >= limits.triggerRunsPerHour)
    return skipped("rate_limited");
  // `new`: a session of its own, named for the run, so a repeated cause never opens a second.
  const sessionId = trigger.session === "new" ? `run-${runId}` : trigger.session;
  let session = await t.lockSession<Session>(sessionId);
  if (session && session.agentId !== agent.id) return failed("session_conflict", sessionId);
  try {
    if (!session) {
      await openSessionIn(ctx, t, sessionId, {
        requestId: `trigger-${runId}`,
        agent: agent.id,
        ownerUserId: agent.ownerUserId ?? "installation",
      });
      session = (await t.lockSession<Session>(sessionId))!;
    }
    // A schedule adds at most one queued message to a busy session; later fires are skipped.
    if ((kind === "schedule" || kind === "at") && !takesMessages(session)) {
      const queued = await t.queuedMessages(sessionId);
      if (queued.some((message) => (message.cause as MessageCause | null)?.triggerId === triggerId))
        return skipped("overlap", sessionId);
    }
    await checkAgentTurn(t, session, QUEUE_SCOPE, ctx);
    const answer = await acceptMessage(ctx, t, session, sessionId, triggerMessage(triggerId, trigger, runId));
    await t.put("sessions", sessionId, session);
    return answer.status === "accepted"
      ? { status: "started", sessionId, turnId: answer.turnId }
      : { status: "queued", sessionId, queuedMessageId: answer.queuedMessageId };
  } catch (error) {
    if (error instanceof HttpError) return failed(error.rejection.code ?? "request_rejected", sessionId);
    throw error;
  }
}

/** The message a run sends: the trigger's prompt, as core wrote it for the trigger. */
function triggerMessage(triggerId: string, trigger: Trigger, runId: string): TurnMessage {
  return {
    command: { type: "message", requestId: runId, idempotencyKey: runId, content: trigger.prompt },
    input: trigger.prompt,
    fileArtifacts: [],
    writer: triggerWriter(triggerId),
    cause: { kind: "trigger", triggerId, runId },
  };
}

// ---------------------------------------------------------------------------
// The routes' work

/** A run as the API shows it. */
export function runView(row: TriggerRunRow): TriggerRun {
  return {
    id: row.id,
    triggerId: row.triggerId,
    kind: row.kind,
    dueAt: row.dueAt,
    firedAt: row.firedAt,
    late: row.late,
    status: row.status,
    reason: row.reason,
    sessionId: row.sessionId,
    turnId: row.turnId,
    queuedMessageId: row.queuedMessageId,
  };
}

/** `GET /v1/agents/{id}/triggers`. */
export async function listTriggers(ctx: TenantContext, agentId: string): Promise<{ triggers: TriggerView[] }> {
  return ctx.store.tx(async (t) => {
    const agent = (await liveEnvironment(t, agentId)) ?? fail(404, `Agent ${agentId} not found`, { code: "not_found" });
    const triggers = await triggersOf(t, agent);
    const rows = await t.agentTriggers(agentId);
    return {
      triggers: rows.flatMap((row): TriggerView[] => {
        const trigger = triggers[row.triggerId];
        if (!trigger) return [];
        return [
          {
            id: row.triggerId,
            kind: row.kind,
            status: row.status,
            pausedReason: row.pausedReason,
            ...(trigger.schedule === undefined ? {} : { schedule: trigger.schedule, timezone: trigger.timezone ?? "UTC" }),
            ...(trigger.at === undefined ? {} : { at: trigger.at }),
            session: trigger.session,
            nextRunAt: row.status === "active" ? row.nextFireAt : null,
            lastRunAt: row.lastFireAt,
          },
        ];
      }),
    };
  });
}

/** The trigger `triggerId` of Agent `agentId`, locked with its Agent, or a 404. */
async function lockedTrigger(t: Tx, agentId: string, triggerId: string) {
  const agent = (await liveEnvironment(t, agentId, { lock: true })) ?? fail(404, `Agent ${agentId} not found`, { code: "not_found" });
  const row = await t.agentTrigger(agentId, triggerId, { lock: true });
  const trigger = (await triggersOf(t, agent))[triggerId];
  if (!row || !trigger) return fail(404, `Agent ${agentId} has no trigger ${triggerId}`, { code: "not_found" });
  return { agent, row, trigger };
}

/** `POST .../triggers/{triggerId}/pause` and `/resume`. */
export async function setTriggerStatus(
  ctx: TenantContext,
  agentId: string,
  triggerId: string,
  action: "pause" | "resume",
): Promise<{ triggers: TriggerView[] }> {
  const changed = await ctx.store.tx(async (t) => {
    const { row, trigger } = await lockedTrigger(t, agentId, triggerId);
    const now = new Date();
    const stamp = now.toISOString();
    if (action === "pause") {
      if (row.status === "paused") return undefined;
      await t.putAgentTrigger({ ...row, status: "paused", pausedReason: "manual", nextFireAt: null, generation: row.generation + 1, updatedAt: stamp });
      await t.agentEvent(agentId, "agent.trigger_paused", { triggerId, reason: "manual" });
      return undefined;
    }
    if (row.status === "active") return undefined;
    const next = nextFireAt(agentId, triggerId, trigger, now, await readRuntimeLimits(t));
    // An `at` runs once: one that ran, or whose time passed, does not run again.
    if (trigger.at !== undefined && (next === null || row.status === "completed"))
      fail(409, `Trigger ${triggerId} was due at ${trigger.at} and does not run again: save a manifest version with a new time.`, {
        code: "trigger_expired",
      });
    const updated: AgentTriggerRow = {
      ...row,
      status: "active",
      pausedReason: null,
      nextFireAt: next?.toISOString() ?? null,
      generation: row.generation + 1,
      updatedAt: stamp,
    };
    await t.putAgentTrigger(updated);
    await t.agentEvent(agentId, "agent.trigger_resumed", { triggerId });
    return updated;
  });
  if (changed) await armTrigger(ctx, changed);
  return listTriggers(ctx, agentId);
}

/**
 * `POST .../triggers/{triggerId}/run`: runs it now, whatever its status, keyed by the request's
 * `Idempotency-Key`, so a retried request makes one run.
 */
export async function runTriggerNow(ctx: TenantContext, agentId: string, triggerId: string, idempotencyKey: string): Promise<TriggerRun> {
  return ctx.store.tx(async (t) => {
    const { agent, row, trigger } = await lockedTrigger(t, agentId, triggerId);
    const run = await deliverRun(ctx, t, agent, triggerId, trigger, row, {
      runKey: `manual:${triggerId}:${idempotencyKey}`,
      dueAt: new Date().toISOString(),
      late: false,
    });
    return runView(run);
  });
}

/** `GET /v1/agents/{id}/runs`: newest first, `limit` per page, after cursor `before`. */
export async function listRuns(
  ctx: TenantContext,
  agentId: string,
  options: { triggerId?: string; cursor?: string; limit: number },
): Promise<{ runs: TriggerRun[]; nextCursor: string | null }> {
  return ctx.store.tx(async (t) => {
    if (!(await liveEnvironment(t, agentId))) fail(404, `Agent ${agentId} not found`, { code: "not_found" });
    const rows = await t.listTriggerRuns(agentId, {
      ...(options.triggerId === undefined ? {} : { triggerId: options.triggerId }),
      ...(options.cursor === undefined ? {} : { before: options.cursor }),
      limit: options.limit + 1,
    });
    const page = rows.slice(0, options.limit);
    return { runs: page.map(runView), nextCursor: rows.length > options.limit ? page.at(-1)!.id : null };
  });
}
