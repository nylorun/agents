/**
 * A pod sandbox's lifecycle (blueprint D34, D36), as one pure decision: from the row, the
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
 * - **Idle** (`trigger: idle`): no turn on an attached session, and none ended within the
 *   Tenant's `limits.idle` → `Suspended` (`sandbox.suspended`, reason `idle`). The volume is
 *   kept; the next turn start asks for `Running` again.
 * - **TTL**: the Sandbox carries `shutdownTime = createdAt + lifecycle.ttl` and the Tenant's
 *   `onExpiry` as its `shutdownPolicy`. Once it passes, the sandbox is `expired`
 *   (`sandbox.expired`), its host epoch moves (its tokens stop working) and turns are refused
 *   (`sandbox_expired`); with `onExpiry: delete` it is deleted. A `PUT` with a longer TTL moves
 *   `expiresAt`, and the next apply revives it with the later `shutdownTime`.
 * - **Lost**: an incarnation that has run (a pod joined) whose Sandbox is gone or whose volume
 *   is missing is `lost` (`sandbox.lost`): its host epoch moves, its Sandbox is deleted, and
 *   only a reset brings the sandbox back. A pod replaced on the same volume is not lost: the
 *   new pod's join bumps the epoch (`sandbox.relaunched`, `join.ts`).
 * - **Delete** (`desired: deleted`): the Sandbox is deleted, and the row once it is gone.
 * - **Reset** (`tenant/sandboxes.ts`) bumps the volume generation: a new name, so a new
 *   Sandbox and volume; the old name is `retiring` and deleted here.
 */
import type { SandboxEventPayload, SandboxEventType } from "@nylorun/core/contracts";
import type { SandboxPodPatch, SandboxPodState, SandboxResource } from "../../store/types.js";
import type { PodStatus } from "./client.js";

/** A pod not ready this long after it was asked to run has failed. */
export const READY_DEADLINE_MS = 5 * 60_000;
/** How soon to look again while the pod changes. */
export const POLL_MS = 2_000;
/** How soon to look again when the sandboxes service does not answer. */
export const UNREACHABLE_RETRY_MS = 5_000;

/** The Tenant's lifecycle settings (D36), read each time a decision is made. */
export interface PodLifecycleConfig {
  readonly onExpiry: "retain" | "delete";
  readonly idleMs: number;
}

/** Why the decision is made: a reconcile, or one of the sandbox's timers firing. */
export type PodTrigger = "reconcile" | "idle" | "ttl";
export type PodTimer = "idle" | "ttl";

export type PodRow = SandboxResource & { readonly pod: SandboxPodState };

export interface PodFacts {
  readonly row: PodRow;
  readonly config: PodLifecycleConfig;
  /** The Sandbox's status; undefined when the sandboxes service did not answer. */
  readonly status: PodStatus | undefined;
  /** The retiring Sandbox's status, when the row names one. */
  readonly retiring?: PodStatus | undefined;
  /** A session attached to the sandbox has a turn running. */
  readonly busy: boolean;
  readonly now: number;
  readonly trigger: PodTrigger;
}

export interface PodEvent<T extends SandboxEventType = SandboxEventType> {
  readonly type: T;
  readonly payload: SandboxEventPayload<T>;
}

export interface PodDecision {
  /** Apply the row's spec (after `patch`) in this mode; `rotateJoin` mints a new join token. */
  readonly apply?: { readonly mode: "Running" | "Suspended"; readonly rotateJoin: boolean };
  /** Sandboxes to delete, by name. */
  readonly delete: readonly string[];
  readonly patch: SandboxPodPatch;
  readonly events: readonly PodEvent[];
  /** The Sandbox is gone and the sandbox deleted: remove the row. */
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

const event = <T extends SandboxEventType>(type: T, payload: SandboxEventPayload<T>): PodEvent =>
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

  const expiresAt = pod.expiresAt === undefined ? undefined : Date.parse(pod.expiresAt);
  if (expiresAt !== undefined && now >= expiresAt) {
    if (pod.observed !== "expired") {
      patch.observed = "expired";
      patch.hostEpoch = pod.hostEpoch + 1;
      events.push(event("sandbox.expired", { onExpiry: facts.config.onExpiry }));
    }
    if (facts.config.onExpiry === "delete") {
      patch.desired = "deleted";
      patch.rev = pod.rev + 1;
      if (status.exists && !status.deleting) deletes.push(pod.k8sName);
      again(POLL_MS);
    }
    return done();
  }
  if (expiresAt !== undefined) arm.push({ timer: "ttl", at: expiresAt });

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
      events.push(event("sandbox.suspended", { reason: "idle" }));
    } else arm.push({ timer: "idle", at: due });
  }

  // An incarnation a pod has joined, whose Sandbox or volume is gone: lost.
  if (pod.podUid !== undefined && (!status.exists || status.deleting || status.volume === "missing")) {
    const reason = !status.exists
      ? "The sandbox's pod and volume were deleted outside the Runtime"
      : status.deleting
        ? "The sandbox is being deleted outside the Runtime"
        : "The sandbox's volume is gone";
    patch.observed = "lost";
    patch.reason = reason;
    patch.hostEpoch = (patch.hostEpoch ?? pod.hostEpoch) + 1;
    events.push(event("sandbox.lost", { reason }));
    if (status.exists && !status.deleting) deletes.push(pod.k8sName);
    if (status.exists) again(POLL_MS);
    return done();
  }

  if (status.deleting) {
    // The previous incarnation of this name is still going (a sandbox deleted and created again).
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
    // A pod started by this apply (a create, a resume) is the sandbox's first, not a relaunch.
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
      events.push(event("sandbox.failed", { reason }));
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
