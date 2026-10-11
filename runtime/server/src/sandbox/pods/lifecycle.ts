/**
 * A pod Environment's lifecycle (blueprint D34, D36), as one pure decision: from the row, the
 * Tenant's lifecycle settings, the Sandbox's status as the sandboxes service sees it and the
 * clock, what to ask of the service, what to write to the row, which events to record, and
 * when to look again. `reconcile.ts` gathers the facts, carries the decision out and runs it
 * again until nothing is left to do; the `Sandbox` object (`execution/`) serializes its runs
 * per sandbox and keeps its timers.
 *
 * - **Create** is eager: a `PUT` of a new pod sandbox asks for `Running` at once. One that is
 *   not ready within `READY_DEADLINE_MS` is `failed`, with the pod's reason; the next turn
 *   start tries again.
 * - **Every change** the Runtime asks for bumps `rev`; the `PUT` carries `opId =
 *   <name>.r<rev>`, so a repeated apply is a no-op at the service, and a Sandbox whose `opId`
 *   is not the row's is applied again.
 * - **Idle** (`trigger: idle`): no turn on a session that names it, and none ended within its
 *   `lifecycle.idle` (at most the Tenant's `limits.idle`) → `Suspended` (`environment.suspended`,
 *   reason `idle`). The volume is kept; the next turn start asks for `Running` again.
 * - **Lost**: an incarnation that has run (a pod joined) whose Sandbox is gone or whose volume
 *   is missing is `lost` (`environment.lost`): its host epoch moves, its Sandbox is deleted, and
 *   only a reset brings the Environment back. agent-sandbox recreates a deleted claim empty, so
 *   the engine's join also checks the id it keeps on the volume (`join.ts`): a new volume is
 *   lost too. A pod replaced on the same volume is not lost: the new pod's join bumps the epoch
 *   (`environment.relaunched`).
 * - **Delete** (`desired: deleted`): the Sandbox is deleted, and the row once it is gone.
 * - **Reset** (`tenant/environments.ts`) bumps the volume generation: a new name, so a new
 *   Sandbox and volume; the old name is `retiring` and deleted here.
 *
 * An unused Environment is deleted by the Tenant sweep (`lifecycle.deleteAfter`), not here.
 */
import type { EnvironmentEventPayload, EnvironmentEventType } from "@nylorun/core/contracts";
import type { Environment, SandboxPodPatch, SandboxPodState } from "../../store/types.js";
import type { PodStatus } from "./client.js";

/** A pod not ready this long after it was asked to run has failed. */
export const READY_DEADLINE_MS = 5 * 60_000;
/** How soon to look again while the pod changes. */
export const POLL_MS = 2_000;
/** How soon to look again when the sandboxes service does not answer. */
export const UNREACHABLE_RETRY_MS = 5_000;

/** The lifecycle settings (D36), read each time a decision is made. */
export interface PodLifecycleConfig {
  readonly idleMs: number;
}

/** Why the decision is made: a reconcile, or the idle timer firing. */
export type PodTrigger = "reconcile" | "idle";
export type PodTimer = "idle";

export type PodRow = Environment & { readonly pod: SandboxPodState };

export interface PodFacts {
  readonly row: PodRow;
  readonly config: PodLifecycleConfig;
  /** The Sandbox's status; undefined when the sandboxes service did not answer. */
  readonly status: PodStatus | undefined;
  /** The retiring Sandbox's status, when the row names one. */
  readonly retiring?: PodStatus | undefined;
  /** A session that names the Environment has a turn running. */
  readonly busy: boolean;
  readonly now: number;
  readonly trigger: PodTrigger;
}

export interface PodEvent<T extends EnvironmentEventType = EnvironmentEventType> {
  readonly type: T;
  readonly payload: EnvironmentEventPayload<T>;
}

export interface PodDecision {
  /** Apply the row's spec (after `patch`) in this mode; `rotateJoin` mints a new join token. */
  readonly apply?: { readonly mode: "Running" | "Suspended"; readonly rotateJoin: boolean };
  /** Sandboxes to delete, by name. */
  readonly delete: readonly string[];
  readonly patch: SandboxPodPatch;
  readonly events: readonly PodEvent[];
  /** The Sandbox is gone and the Environment deleted: remove the row. */
  readonly removeRow?: true;
  /** Look again this soon. */
  readonly retryAfterMs?: number;
  /** Timers to (re)arm, at ms since the epoch. */
  readonly arm: readonly { readonly timer: PodTimer; readonly at: number }[];
}

/** The service's operation id of the row's current spec. */
export function opIdOf(pod: Pick<SandboxPodState, "k8sName" | "rev">): string {
  return `${pod.k8sName}.r${pod.rev}`;
}

/** No Sandbox, pod or volume is left. */
function gone(status: PodStatus): boolean {
  return !status.exists && !status.podPhase && status.volume === "missing";
}

const event = <T extends EnvironmentEventType>(type: T, payload: EnvironmentEventPayload<T>): PodEvent =>
  ({ type, payload }) as PodEvent;

export function decide(facts: PodFacts): PodDecision {
  const { row, status, now } = facts;
  const pod = row.pod;
  const patch: SandboxPodPatch = {};
  const events: PodEvent[] = [];
  const arm: { timer: PodTimer; at: number }[] = [];
  const deletes: string[] = [];
  let retryAfterMs: number | undefined;
  const again = (ms: number) => {
    retryAfterMs = retryAfterMs === undefined ? ms : Math.min(retryAfterMs, ms);
  };
  const done = (extra: Partial<Pick<PodDecision, "apply" | "removeRow">> = {}): PodDecision => ({
    ...extra,
    delete: deletes,
    patch,
    events,
    arm,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

  // An earlier incarnation's Sandbox (reset, loss) is deleted until it is gone.
  if (pod.retiring !== undefined) {
    const retiring = facts.retiring;
    if (retiring === undefined) again(UNREACHABLE_RETRY_MS);
    else if (gone(retiring)) patch.retiring = null;
    else {
      if (retiring.exists && !retiring.deleting) deletes.push(pod.retiring);
      again(POLL_MS);
    }
  }
  if (status === undefined) {
    again(UNREACHABLE_RETRY_MS);
    return done();
  }

  if (pod.desired === "deleted") {
    if (gone(status) && (pod.retiring === undefined || patch.retiring === null))
      return done({ removeRow: true });
    if (status.exists && !status.deleting) deletes.push(pod.k8sName);
    if (pod.observed !== "deleting") patch.observed = "deleting";
    again(POLL_MS);
    return done();
  }

  // Lost is terminal: only a reset (a new name) leaves it.
  if (pod.observed === "lost") {
    if (status.exists && !status.deleting) deletes.push(pod.k8sName);
    if (status.exists) again(POLL_MS);
    return done();
  }

  let desired = pod.desired;
  let rev = pod.rev;
  if (facts.trigger === "idle" && desired === "running" && !facts.busy) {
    const last = Date.parse(pod.lastActiveAt ?? row.createdAt);
    const due = last + facts.config.idleMs;
    if (now >= due) {
      desired = "suspended";
      rev += 1;
      patch.desired = desired;
      patch.rev = rev;
      patch.hostEpoch = pod.hostEpoch + 1;
      events.push(event("environment.suspended", { reason: "idle" }));
    } else arm.push({ timer: "idle", at: due });
  }

  // An incarnation a pod has joined, whose Sandbox or volume is gone: lost.
  if (pod.podUid !== undefined && (!status.exists || status.deleting || status.volume === "missing")) {
    const reason = !status.exists
      ? "The Environment's pod and volume were deleted outside the Runtime"
      : status.deleting
        ? "The Environment's pod is being deleted outside the Runtime"
        : "The Environment's volume is gone";
    patch.observed = "lost";
    patch.reason = reason;
    patch.hostEpoch = (patch.hostEpoch ?? pod.hostEpoch) + 1;
    events.push(event("environment.lost", { reason }));
    if (status.exists && !status.deleting) deletes.push(pod.k8sName);
    if (status.exists) again(POLL_MS);
    return done();
  }

  if (status.deleting) {
    // The previous incarnation of this name is still going (an Environment deleted and created again).
    again(POLL_MS);
    return done();
  }
  const opId = opIdOf({ k8sName: pod.k8sName, rev });
  if (desired === "suspended" && !status.exists) {
    if (pod.observed !== "suspended") patch.observed = "suspended";
    return done();
  }
  if (status.opId !== opId) {
    if (desired === "running" && (pod.observed !== "creating" || pod.startedAt === undefined)) {
      patch.observed = "creating";
      patch.startedAt = new Date(now).toISOString();
      patch.reason = null;
    }
    // A pod started by this apply (a create, a resume) is the Environment's first, not a relaunch.
    if (desired === "running" && pod.podUid !== undefined) patch.podUid = null;
    again(POLL_MS);
    return done({
      apply: { mode: desired === "running" ? "Running" : "Suspended", rotateJoin: !status.exists },
    });
  }

  if (desired === "running") {
    if (status.ready) {
      if (pod.observed !== "running") {
        patch.observed = "running";
        patch.reason = null;
      }
      return done();
    }
    const startedAt = Date.parse(pod.startedAt ?? row.updatedAt);
    if (pod.observed === "failed") return done();
    if (now - startedAt >= READY_DEADLINE_MS) {
      const reason =
        [status.reason, status.message].filter(Boolean).join(": ") ||
        `The pod was not ready within ${READY_DEADLINE_MS / 60_000} minutes`;
      patch.observed = "failed";
      patch.reason = reason;
      events.push(event("environment.failed", { reason }));
      return done();
    }
    if (pod.observed !== "creating") patch.observed = "creating";
    again(POLL_MS);
    return done();
  }

  // Suspended, applied: suspended once its pod is gone.
  if (status.suspended || !status.podPhase) {
    if (pod.observed !== "suspended") patch.observed = "suspended";
    return done();
  }
  again(POLL_MS);
  return done();
}
