/**
 * Flow host: the Session Store side of workflow sessions (architecture §10–12).
 *
 * Every function that touches state takes the caller's transaction `t: Tx` and
 * is async. Nothing here publishes, notifies or schedules directly (seam rule
 * 1): events go through `t.event(...)`, which the store publishes after
 * commit, and wakes go through `t.afterCommit(() => schedule(id))`. Functions
 * that rewrite a session-scoped document lock that session first with
 * `t.lockSession` (a no-op when the caller already holds it).
 *
 * Exported signatures:
 *
 * - `deriveSessionId(workflowSessionId, path, ...parts): string`
 * - `deriveAgentEffectSessionId(workflowSessionId, path, request): string`
 * - `isWorkflowManifest(manifest): manifest is WorkflowManifest`
 * - `isFlowToolEffect(request): boolean`, `isFlowEffect(request): boolean`
 * - `pathDepth(path): number`
 * - `countActiveFlowWork(t, workflowSessionId, turnId): Promise<number>`
 * - `wakeLinkedWorkflow({ t, agentSessionId, output?, failed?, cancelled?, error?, schedule }): Promise<void>`
 * - `reconcilePendingAgentEffects({ t, schedule }): Promise<void>`
 * - `reofferOrphanedFnVerifyClaims(t): Promise<number>`
 * - `planCancelCascade({ t, workflowSessionId, turnId }): Promise<CascadeCancelPlan>`
 * - `cancelSiblingWork({ t, workflowSessionId, turnId, siblingPaths?, cancelEffectIds? }): Promise<CancelSiblingResult>`
 * - `fenceWorkflowActions({ t, workflowSessionId, turnId }): Promise<{ cancelled; uncertain }>`
 * - `aggregateWaits({ t, workflowSessionId }): Promise<FlowWait[]>`
 * - `findInteractionOwner({ t, workflowSessionId, interactionId }): Promise<{ sessionId; path } | undefined>`
 * - `foreignInteractionConflict({ t, workflowSessionId, interactionId }): Promise<{ status: 409; message; ownerSessionId } | undefined>`
 * - `wakeForQueuedEffects({ t, workflowSessionId, turnId, limits, schedule }): Promise<boolean>`
 *
 * `schedule: (sessionId: string) => void` runs after commit, never inside `t`.
 */
import { createHash } from "node:crypto";
import type { Action, ActionOutcome } from "@nylorun/core/contracts";
import type { JsonValue, WorkflowManifest } from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import type { EffectDoc, Tx } from "../store/types.js";
import { mayDispatchMore, type FlowLimits } from "./limits.js";

/** Deterministic agent session id: derive(workflowSessionId, path, …parts). */
export function deriveSessionId(
  workflowSessionId: string,
  path: string,
  ...parts: string[]
): string {
  const digest = createHash("sha256")
    .update([workflowSessionId, path, ...parts].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `wf_${digest}`;
}

/**
 * Linked agent session id for a flow agent effect.
 * Verifier agents (`context.role === "verify-agent"`) get a unique session per
 * (path, turnId, iterations) so prior verdicts cannot leak across Loop iterations.
 */
export function deriveAgentEffectSessionId(
  workflowSessionId: string,
  path: string,
  request: {
    readonly turnId: string;
    readonly iterations?: string;
    readonly context?: Record<string, unknown>;
  }
): string {
  if (request.context?.role === "verify-agent") {
    const iterations = request.iterations ?? "-";
    const iterParts =
      iterations !== "-" && iterations.length > 0 ? iterations.split(".") : [];
    return deriveSessionId(
      workflowSessionId,
      path,
      "verify",
      request.turnId,
      ...iterParts
    );
  }
  return deriveSessionId(workflowSessionId, path);
}

export function isWorkflowManifest(
  manifest: unknown
): manifest is WorkflowManifest {
  return (
    !!manifest &&
    typeof manifest === "object" &&
    (manifest as { kind?: unknown }).kind === "workflow"
  );
}

/** Flow tool-node effect: `tool` with path/key and no agent capabilityId. */
export function isFlowToolEffect(request: HostEffect): boolean {
  return (
    request.kind === "tool" &&
    typeof request.path === "string" &&
    request.path.length > 0 &&
    typeof request.key === "string" &&
    request.key.length > 0 &&
    request.capabilityId === undefined
  );
}

export function isFlowEffect(request: HostEffect): boolean {
  return (
    request.kind === "agent" ||
    request.kind === "fn" ||
    request.kind === "verify" ||
    isFlowToolEffect(request)
  );
}

export type FlowLink = {
  readonly workflowSessionId: string;
  readonly path: string;
  readonly effectId: string;
  readonly turnId: string;
};

export type FlowHostSession = {
  id: string;
  agentId: string;
  ownerUserId: string;
  manifest: any;
  manifestHash: string;
  implementationVersion: string;
  status: string;
  activeTurnId: string | null;
  info?: any;
  vaultIds?: readonly string[];
  credentialSelections?: readonly unknown[];
  creation?: unknown;
  waits?: unknown;
  lastOutput?: JsonValue;
  error?: string;
};

export type FlowWait = {
  readonly sessionId: string;
  readonly path: string;
  readonly interactionId: string;
  readonly kind: string;
  readonly invocationId?: string;
  readonly wait?: unknown;
  readonly status?: string;
};

export type CancelSiblingResult = {
  readonly cancelledActions: string[];
  readonly uncertainActions: string[];
  readonly agentSessionIds: string[];
};

export type CascadeCancelPlan = {
  /** Linked agent sessions to cancel, deepest path first. */
  readonly agentSessionIds: string[];
  readonly pendingActionIds: string[];
  readonly claimedActionIds: string[];
};

/** Wakes a session after commit. */
type Schedule = (sessionId: string) => void;

/** Effect documents as the flow host writes them. */
type FlowEffect = EffectDoc & {
  agentSessionId?: string;
  outcome?: ActionOutcome;
  error?: string;
};

const OPEN_ACTION: Action["status"][] = ["pending", "claimed"];

function scheduleAfterCommit(t: Tx, schedule: Schedule, id: string): void {
  t.afterCommit(() => schedule(id));
}

/** Active agent turns + pending/claimed actions for one workflow turn. */
export async function countActiveFlowWork(
  t: Tx,
  workflowSessionId: string,
  turnId: string
): Promise<number> {
  const effects = await t.effectsForTurn<FlowEffect>(workflowSessionId, turnId);
  const openActions = new Set(
    (
      await t.actionsForSession(workflowSessionId, {
        turnId,
        statuses: OPEN_ACTION,
      })
    ).map((action) => action.actionId)
  );
  let n = 0;
  for (const effect of effects) {
    if (effect.status === "queued") continue;
    if (effect.status === "completed" || effect.status === "cancelled")
      continue;
    if (effect.request?.kind === "agent" && effect.status === "pending") {
      n += 1;
      continue;
    }
    if (
      (effect.request?.kind === "fn" ||
        effect.request?.kind === "verify" ||
        isFlowToolEffect(effect.request)) &&
      openActions.has(effect.request.effectId)
    )
      n += 1;
  }
  return n;
}

/** After an agent turn settles, wake the owning workflow if linked. */
export async function wakeLinkedWorkflow(input: {
  readonly t: Tx;
  readonly agentSessionId: string;
  readonly output?: JsonValue;
  readonly failed?: boolean;
  readonly cancelled?: boolean;
  readonly error?: string;
  readonly schedule: Schedule;
}): Promise<void> {
  const { t } = input;
  const link = await t.get<FlowLink>("links", input.agentSessionId);
  if (!link) return;
  const workflow = await t.lockSession<FlowHostSession>(link.workflowSessionId);
  if (!workflow) return;
  const effect = await t.get<FlowEffect>("effects", link.effectId);
  if (!effect || effect.status === "completed") return;
  if (workflow.activeTurnId !== link.turnId) return;

  const outcome: ActionOutcome = input.cancelled
    ? {
        value: {
          kind: "failed",
          code: "agent.cancelled",
          message: input.error ?? "Agent turn was cancelled",
        },
      }
    : input.failed
    ? {
        value: {
          kind: "failed",
          code: "agent.failed",
          message: input.error ?? "Agent turn failed",
        },
      }
    : { value: input.output ?? null };

  await t.put("effects", link.effectId, {
    ...effect,
    status: "completed",
    outcome,
  });

  workflow.status = "runnable";
  await t.put("sessions", workflow.id, workflow);
  scheduleAfterCommit(t, input.schedule, workflow.id);
}

/** On Runtime start: settle pending agent effects whose linked turns already finished. */
export async function reconcilePendingAgentEffects(input: {
  readonly t: Tx;
  readonly schedule: Schedule;
}): Promise<void> {
  const { t } = input;
  const effects = await t.effectsWithStatus<FlowEffect>(["pending"], {
    kinds: ["agent"],
  });
  for (const effect of effects) {
    const id =
      typeof effect.agentSessionId === "string"
        ? effect.agentSessionId
        : undefined;
    if (!id) continue;
    const workflow = await t.lockSession<FlowHostSession>(
      effect.request.sessionId
    );
    const agent = await t.get<FlowHostSession>("sessions", id);
    if (workflow && workflow.status === "waiting") {
      workflow.status = "runnable";
      await t.put("sessions", workflow.id, workflow);
      scheduleAfterCommit(t, input.schedule, workflow.id);
    }
    if (!agent) continue;
    if (agent.status === "completed") {
      await wakeLinkedWorkflow({
        t,
        agentSessionId: id,
        output: agent.lastOutput ?? null,
        schedule: input.schedule,
      });
    } else if (agent.status === "failed") {
      await wakeLinkedWorkflow({
        t,
        agentSessionId: id,
        failed: true,
        error: agent.error,
        schedule: input.schedule,
      });
    } else if (agent.status === "cancelled") {
      await wakeLinkedWorkflow({
        t,
        agentSessionId: id,
        cancelled: true,
        error: agent.error,
        schedule: input.schedule,
      });
    } else if (agent.status === "running" || agent.status === "runnable") {
      scheduleAfterCommit(t, input.schedule, id);
    } else if (agent.status === "paused") {
      // Linked pause surfaces on the workflow waits list; keep waiting.
      if (workflow && workflow.status !== "paused") {
        const waits = await aggregateWaits({
          t,
          workflowSessionId: workflow.id,
        });
        if (waits.length > 0) {
          workflow.status = "paused";
          workflow.waits = waits;
          await t.put("sessions", workflow.id, workflow);
        }
      }
    }
  }
}

/** Re-offer orphaned fn/verify claims after a process restart (SD-P7 / WF-C9). */
export async function reofferOrphanedFnVerifyClaims(t: Tx): Promise<number> {
  const claimed = await t.actionsWithStatus(["claimed"], {
    kinds: ["fn", "verify"],
  });
  for (const action of claimed) {
    const s = await t.lockSession<FlowHostSession>(action.sessionId);
    action.status = "pending";
    (action as { claimId: null }).claimId = null;
    (action as { leaseExpiresAt: null }).leaseExpiresAt = null;
    await t.put("actions", action.actionId, action);
    if (s && (s.status === "waiting" || s.status === "running")) {
      s.status = "runnable";
      await t.put("sessions", s.id, s);
    }
  }
  return claimed.length;
}

/** Path depth for deepest-first cancel ordering. */
export function pathDepth(path: string): number {
  if (!path) return 0;
  return path.split("/").filter(Boolean).length;
}

/**
 * Plan a cancel cascade for a workflow session: linked agents deepest first,
 * then pending → cancelled and claimed → uncertain actions (SD-P11 / WF-R53).
 */
export async function planCancelCascade(input: {
  readonly t: Tx;
  readonly workflowSessionId: string;
  readonly turnId: string | null;
}): Promise<CascadeCancelPlan> {
  const { t } = input;
  const agentEntries = (await t.linkedSessions(input.workflowSessionId)).map(
    (linked) => ({ sessionId: linked.agentSessionId, path: linked.link.path })
  );
  agentEntries.sort((a, b) => pathDepth(b.path) - pathDepth(a.path));

  const pendingActionIds: string[] = [];
  const claimedActionIds: string[] = [];
  const actions = await t.actionsForSession(input.workflowSessionId, {
    ...(input.turnId !== null ? { turnId: input.turnId } : {}),
    statuses: OPEN_ACTION,
  });
  for (const action of actions) {
    if (action.status === "pending") pendingActionIds.push(action.actionId);
    else if (action.status === "claimed")
      claimedActionIds.push(action.actionId);
  }

  return {
    agentSessionIds: agentEntries.map((e) => e.sessionId),
    pendingActionIds,
    claimedActionIds,
  };
}

/**
 * Cancel sibling work under a Parallel/Map parent when one branch fails (PAR-R6).
 * Agent turns listed in `agentSessionIds` are returned for the caller to cancel;
 * pending actions → cancelled, claimed tool actions → uncertain.
 * When `cancelEffectIds` is provided, those effects are marked cancelled and their
 * paths are included in the sibling path set.
 */
export async function cancelSiblingWork(input: {
  readonly t: Tx;
  readonly workflowSessionId: string;
  readonly turnId: string;
  /** Paths of siblings still running (not the failed branch). */
  readonly siblingPaths?: readonly string[];
  /** Effect ids the flow engine marked for fail-fast cancel. */
  readonly cancelEffectIds?: readonly string[];
}): Promise<CancelSiblingResult> {
  const { t } = input;
  await t.lockSession(input.workflowSessionId);
  const cancelledActions: string[] = [];
  const uncertainActions: string[] = [];
  const agentSessionIds: string[] = [];

  const siblingPaths = new Set<string>(input.siblingPaths ?? []);
  for (const effectId of input.cancelEffectIds ?? []) {
    const effect = await t.get<FlowEffect>("effects", effectId);
    if (!effect) continue;
    const path =
      typeof effect.request?.path === "string"
        ? effect.request.path
        : undefined;
    if (path) siblingPaths.add(path);
    if (
      effect.status === "pending" ||
      effect.status === "queued" ||
      effect.status === "uncertain"
    ) {
      effect.status = "cancelled";
      await t.put("effects", effectId, effect);
    }
  }

  const matchesSibling = (path: string | undefined): boolean => {
    if (!path) return false;
    return [...siblingPaths].some(
      (sib) => path === sib || path.startsWith(`${sib}/`)
    );
  };

  for (const { agentSessionId, link, session } of await t.linkedSessions(
    input.workflowSessionId
  )) {
    if (!matchesSibling(link.path)) continue;
    if (
      session.activeTurnId &&
      ["running", "runnable", "paused", "waiting"].includes(session.status)
    )
      agentSessionIds.push(agentSessionId);
  }

  const actions = await t.actionsForSession(input.workflowSessionId, {
    turnId: input.turnId,
    statuses: OPEN_ACTION,
  });
  for (const action of actions) {
    if (!matchesSibling((action as { path?: string }).path)) continue;
    const next = action.status === "claimed" ? "uncertain" : "cancelled";
    action.status = next;
    await t.put("actions", action.actionId, action);
    const effect = await t.get<FlowEffect>("effects", action.actionId);
    if (effect) {
      effect.status = next;
      await t.put("effects", action.actionId, effect);
    }
    if (next === "cancelled") cancelledActions.push(action.actionId);
    else uncertainActions.push(action.actionId);
  }

  return { cancelledActions, uncertainActions, agentSessionIds };
}

/**
 * Apply cancel fencing to workflow-session actions (pending→cancelled, claimed→uncertain).
 */
export async function fenceWorkflowActions(input: {
  readonly t: Tx;
  readonly workflowSessionId: string;
  readonly turnId: string | null;
}): Promise<{ cancelled: string[]; uncertain: string[] }> {
  const { t } = input;
  await t.lockSession(input.workflowSessionId);
  const turn = input.turnId !== null ? { turnId: input.turnId } : {};
  const cancelled: string[] = [];
  const uncertain: string[] = [];
  const actions = await t.actionsForSession(input.workflowSessionId, {
    ...turn,
    statuses: OPEN_ACTION,
  });
  for (const action of actions) {
    const next = action.status === "claimed" ? "uncertain" : "cancelled";
    action.status = next;
    await t.put("actions", action.actionId, action);
    const effect = await t.get<FlowEffect>("effects", action.actionId);
    if (effect) {
      effect.status = next;
      await t.put("effects", action.actionId, effect);
    }
    if (next === "cancelled") cancelled.push(action.actionId);
    else uncertain.push(action.actionId);
  }
  // Drop queued effects that never started.
  const queued = await t.effectsForSession<FlowEffect>(
    input.workflowSessionId,
    { ...turn, statuses: ["queued"] }
  );
  for (const effect of queued) {
    effect.status = "cancelled";
    await t.put("effects", effect.request.effectId, effect);
    cancelled.push(effect.request.effectId);
  }
  return { cancelled, uncertain };
}

function waitsFromSession(
  sessionId: string,
  path: string,
  raw: unknown
): FlowWait[] {
  if (!Array.isArray(raw)) return [];
  const waits: FlowWait[] = [];
  for (const call of raw as any[]) {
    const interaction = call.interaction ?? call;
    const interactionId = String(interaction?.id ?? call.interactionId ?? "");
    if (!interactionId) continue;
    waits.push({
      sessionId,
      path,
      interactionId,
      kind: String(interaction?.kind ?? call.kind ?? "approval"),
      ...(call.invocationId !== undefined
        ? { invocationId: String(call.invocationId) }
        : {}),
      ...(call.wait !== undefined ? { wait: call.wait } : {}),
      ...(call.status !== undefined ? { status: String(call.status) } : {}),
    });
  }
  return waits;
}

/**
 * Aggregate human waits across the workflow session and linked agent sessions (WF-R51).
 */
export async function aggregateWaits(input: {
  readonly t: Tx;
  readonly workflowSessionId: string;
}): Promise<FlowWait[]> {
  const { t } = input;
  const workflow = await t.get<FlowHostSession>(
    "sessions",
    input.workflowSessionId
  );
  if (!workflow) return [];

  const waits: FlowWait[] = [];
  // Workflow-owned interactions (tool-node / verify approvals) live on the workflow session.
  if (Array.isArray(workflow.waits))
    waits.push(...waitsFromSession(workflow.id, "", workflow.waits));
  else if (
    workflow.waits &&
    typeof workflow.waits === "object" &&
    Array.isArray((workflow.waits as any).interactions)
  )
    waits.push(
      ...waitsFromSession(workflow.id, "", (workflow.waits as any).interactions)
    );

  for (const { agentSessionId, link, session } of await t.linkedSessions<
    FlowHostSession
  >(input.workflowSessionId)) {
    if (session.status !== "paused") continue;
    waits.push(...waitsFromSession(agentSessionId, link.path, session.waits));
  }

  return waits;
}

/**
 * Look up which session owns an interaction id. Used for 409 foreign approvals (WF-R52).
 */
export async function findInteractionOwner(input: {
  readonly t: Tx;
  readonly workflowSessionId: string;
  readonly interactionId: string;
}): Promise<{ sessionId: string; path: string } | undefined> {
  const waits = await aggregateWaits(input);
  const hit = waits.find((w) => w.interactionId === input.interactionId);
  if (hit) return { sessionId: hit.sessionId, path: hit.path };

  // Also scan linked sessions' waits that aggregateWaits skipped (not paused).
  for (const { agentSessionId, link, session } of await input.t.linkedSessions<
    FlowHostSession
  >(input.workflowSessionId)) {
    const raw = session.waits;
    if (!Array.isArray(raw)) continue;
    for (const call of raw as any[]) {
      const id = String(call.interaction?.id ?? call.interactionId ?? "");
      if (id === input.interactionId)
        return { sessionId: agentSessionId, path: link.path };
    }
  }
  return undefined;
}

/**
 * If approve/respond targets an interaction owned by a linked agent session,
 * return a 409 message naming that session (WF-R52 / LOOP-A4).
 */
export async function foreignInteractionConflict(input: {
  readonly t: Tx;
  readonly workflowSessionId: string;
  readonly interactionId: string;
}): Promise<
  { status: 409; message: string; ownerSessionId: string } | undefined
> {
  const owner = await findInteractionOwner(input);
  if (!owner) return undefined;
  if (owner.sessionId === input.workflowSessionId) return undefined;
  return {
    status: 409,
    message: `Interaction belongs to session ${owner.sessionId}`,
    ownerSessionId: owner.sessionId,
  };
}

/**
 * When concurrency slots free, re-enter the workflow so queued effects can start
 * (status stays `queued` until the effect resolver dispatches them). Returns
 * true when a wake was scheduled.
 */
export async function wakeForQueuedEffects(input: {
  readonly t: Tx;
  readonly workflowSessionId: string;
  readonly turnId: string;
  readonly limits: FlowLimits;
  readonly schedule: Schedule;
}): Promise<boolean> {
  const { t } = input;
  if (
    !mayDispatchMore(
      await countActiveFlowWork(t, input.workflowSessionId, input.turnId),
      input.limits
    )
  )
    return false;
  const queued = await t.effectsForTurn(
    input.workflowSessionId,
    input.turnId,
    ["queued"]
  );
  if (queued.length === 0) return false;
  const workflow = await t.lockSession<FlowHostSession>(
    input.workflowSessionId
  );
  if (workflow && workflow.status === "waiting") {
    workflow.status = "runnable";
    await t.put("sessions", workflow.id, workflow);
  }
  scheduleAfterCommit(t, input.schedule, input.workflowSessionId);
  return true;
}
