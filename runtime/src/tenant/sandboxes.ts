/**
 * Sandboxes as a resource (blueprint D39, F7.1; Host feature `sandboxes`): `PUT`, `GET` and
 * `DELETE /v1/sandboxes/{id}`, the list by label, sessions attaching with `sandbox: { id }`, and
 * the checks every turn start makes on the sandbox its session is attached to.
 *
 * - **No scope.** The Runtime decides nothing about who shares a sandbox. It stores the
 *   sandbox's id, kind, spec and labels, and the session body names the sandbox it is attached
 *   to (`Session.sandboxId`); deleting a session (a sessions reset) only detaches it.
 * - **Access.** An application key reaches every sandbox, and so does an application key acting
 *   for a subject (`Nylorun-Subject`), which needs `sandboxes:write` to change one. A subject
 *   token reaches only the ids its `sbx` grants match, and changes them only with
 *   `sandboxes:write`; any other id is the 404 of a missing one.
 * - **Serial turns.** One turn at a time per sandbox: a session whose sandbox another attached
 *   session's turn holds is refused (`409 sandbox_busy`), as the session sandbox route is
 *   refused while its session's turn runs. Commands within the workspace keep queueing in the
 *   Sandbox Manager.
 * - **Kinds.** `virtual`: its workspace is the virtual backend's, keyed by the sandbox id
 *   (`SandboxManager.sandboxKeyOf`) and created on the first tool call. `pod` (F7.2, Host feature
 *   `sandbox-pods`): an agent-sandbox pod on the Tenant's cluster, created at once, whose engine
 *   runs the turns of the sessions attached to it. Its lifecycle (`sandbox/pods/lifecycle.ts`)
 *   runs in the `Sandbox` object: this module records what is wanted (`desired`, `rev`) and asks
 *   for a reconcile after the commit (`ctx.sandboxSignal`). Without sandbox pods kind `pod` is
 *   `409 sandbox_unavailable`. `POST .../stop` suspends a pod (the volume is kept; the next turn
 *   starts it), `POST .../reset` gives it a new pod on a new volume. An expired pod refuses
 *   turns (`sandbox_expired`) until a `PUT` sets a longer `lifecycle.ttl`; a lost one
 *   (`sandbox_lost`) until a reset. Deleting a pod sandbox keeps its row (`desired: deleted`,
 *   invisible here) until its Sandbox is gone.
 * - **Lifecycle events** go to the sandbox's own stream in the record (`Tx.sandboxEvent`,
 *   `record/sandbox.ts`); the session's log records `sandbox.attached` too.
 */
import {
  sandboxGranted,
  type PutSandboxRequest,
  type SandboxView,
} from "@nylorun/core/contracts";
import type { SandboxManifest } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import type { SandboxPodState, SandboxResource, Tx } from "../store/types.js";
import { resolveSandbox } from "../sandbox/resolve.js";
import { sandboxWorkspaceKey } from "../sandbox/records.js";
import {
  effectiveSandboxConfig,
  memoryMiB,
  readSandboxConfig,
} from "../sandbox/tenant-config.js";
import { podName } from "../sandbox/pods/name.js";
import { expiresAtOf, podLifecycleConfig, type PodSandboxSpec } from "../sandbox/pods/spec.js";
import { requirePods } from "../sandbox/placement.js";
import { parseSandboxDuration } from "@nylorun/core/define";
import type { AuthScope, Session, TenantContext } from "./context.js";
import { fail } from "./http.js";

/** The `sbx` grants that limit `scope`, or undefined when it reaches every sandbox. */
export function sandboxGrantsOf(scope: AuthScope): readonly string[] | undefined {
  return scope.kind === "token" ? (scope.sandboxes ?? []) : undefined;
}

/** The subject whose sessions a sandbox's view lists, when the request acts for one. */
function ownerOf(scope: AuthScope): string | undefined {
  return scope.kind === "token" || scope.kind === "subject" ? scope.subject : undefined;
}

const notFound = (): never => fail(404, "Sandbox not found");

/** The sandbox, when `grants` reach it; otherwise the 404 of a missing one. */
function reachable(
  grants: readonly string[] | undefined,
  id: string,
): void {
  if (grants !== undefined && !sandboxGranted(grants, id)) notFound();
}

/** A pod sandbox being deleted is no longer a sandbox, here. */
function live(row: SandboxResource | undefined): SandboxResource | undefined {
  return row?.pod?.desired === "deleted" ? undefined : row;
}

/** A sandbox resource, unless it is gone or being deleted. */
export async function liveSandbox(
  t: Tx,
  id: string,
  options: { lock?: boolean } = {},
): Promise<SandboxResource | undefined> {
  return live(await t.sandboxResource(id, options));
}

/** The compute state a pod's view reports. */
function podState(pod: SandboxPodState): SandboxView["state"] {
  if (pod.observed === "running") return "running";
  if (pod.observed === "creating") return "creating";
  return "stopped";
}

async function viewOf(
  ctx: TenantContext,
  t: Tx,
  sandbox: SandboxResource,
  owner: string | undefined,
): Promise<SandboxView> {
  const sessions = await t.sessionsOnSandbox<Session>(sandbox.id);
  const record = sandbox.pod
    ? undefined
    : await t.get<{ state?: SandboxView["state"] }>(
        "sandboxes",
        sandboxWorkspaceKey(ctx.config.tenantId, sandbox.id),
      );
  const pod = sandbox.pod;
  return {
    id: sandbox.id,
    kind: sandbox.kind,
    labels: sandbox.labels,
    spec: sandbox.spec as Record<string, unknown>,
    state: pod ? podState(pod) : (record?.state ?? "ready"),
    ...(pod
      ? {
          pod: {
            desired: pod.desired,
            observed: pod.observed,
            volumeGeneration: pod.volumeGen,
            hostEpoch: pod.hostEpoch,
            ...(pod.expiresAt ? { expiresAt: pod.expiresAt } : {}),
            ...(pod.reason ? { reason: pod.reason } : {}),
          },
        }
      : {}),
    sessions: sessions
      .filter((session) => owner === undefined || session.ownerUserId === owner)
      .map((session) => ({ id: session.id, activeTurnId: session.activeTurnId })),
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
  };
}

/** The spec a `PUT` asks for, resolved against the Tenant's limits. */
function resolveSpec(
  body: PutSandboxRequest,
  config: ReturnType<typeof effectiveSandboxConfig>,
  ttlLimit: string | undefined,
): SandboxManifest {
  const pod = body.kind === "pod";
  if (!pod && (body.storage !== undefined || body.lifecycle !== undefined))
    fail(400, "storage and lifecycle are for kind pod only");
  const resolved = resolveSandbox({
    request: {
      ...(body.image === undefined ? {} : { image: body.image }),
      ...(body.network === undefined ? {} : { network: body.network }),
      ...(body.resources === undefined ? {} : { resources: body.resources }),
    },
    config,
    actingForSubject: false,
    kind: pod ? "pod" : "virtual",
  });
  if (resolved.kind === "error") return fail(resolved.status, resolved.errors.join(" "));
  if (resolved.kind === "none") return fail(400, "The sandbox has no spec");
  if (!pod) return resolved.spec;
  checkTtl(body.lifecycle?.ttl, ttlLimit);
  return {
    ...resolved.spec,
    ...(body.storage === undefined ? {} : { storage: body.storage }),
    ...(body.lifecycle?.ttl === undefined ? {} : { lifecycle: { ttl: body.lifecycle.ttl } }),
  } as SandboxManifest;
}

/** Refuses a TTL longer than the Tenant's `limits.ttl`. */
function checkTtl(ttl: string | undefined, limit: string | undefined): void {
  if (ttl === undefined || limit === undefined) return;
  if ((parseSandboxDuration(ttl) ?? 0) > (parseSandboxDuration(limit) ?? Infinity))
    fail(400, `lifecycle.ttl is ${ttl}; this Tenant allows at most ${limit}.`);
}

/**
 * Why an existing sandbox does not match what a `PUT` asks for, comparing only the fields the
 * request sends: an `ensure` that repeats its spec keeps working after the Tenant's defaults or
 * limits change. A pod's `lifecycle.ttl` is not part of the fixed spec.
 */
function specMismatch(existing: SandboxResource, body: PutSandboxRequest): string | undefined {
  if (body.kind !== undefined && body.kind !== existing.kind) return "kind";
  if (body.image !== undefined && body.image !== existing.spec.image) return "image";
  if (body.network !== undefined) {
    const asked = [...new Set((body.network.allow ?? []).map((host) => host.toLowerCase()))].sort();
    const has = [...(existing.spec.network?.allow ?? [])].sort();
    if (canonical(asked) !== canonical(has)) return "network";
  }
  const resources = existing.spec.resources;
  if (body.resources?.cpus !== undefined && body.resources.cpus !== resources?.cpus) return "resources";
  if (
    body.resources?.memory !== undefined &&
    (resources?.memory === undefined || memoryMiB(body.resources.memory) !== memoryMiB(resources.memory))
  )
    return "resources";
  if (body.storage !== undefined && body.storage !== (existing.spec as PodSandboxSpec).storage) return "storage";
  return undefined;
}

/** Asks for a pod's reconcile once the transaction commits. */
function reconcileAfter(ctx: TenantContext, t: Tx, id: string): void {
  t.afterCommit(() => ctx.sandboxSignal(id, { kind: "reconcile" }));
}

/** Asks the pod to run (again): a new `rev`, so the service applies it. */
async function wantRunning(t: Tx, sandbox: SandboxResource & { pod: SandboxPodState }, now: string) {
  await t.updateSandboxPod(
    sandbox.id,
    {
      desired: "running",
      rev: sandbox.pod.rev + 1,
      observed: "creating",
      startedAt: now,
      lastActiveAt: now,
      reason: null,
    },
    now,
  );
}

/**
 * `PUT /v1/sandboxes/{id}`: creates the sandbox (within the Tenant's limit on their number), or
 * finds the one with this id, so "get or create" is one call. The spec is fixed once it exists;
 * labels, when sent, replace its labels. On an existing pod sandbox it also starts a stopped or
 * failed pod again, and a new `lifecycle.ttl` sets a new expiry (reviving an expired one).
 */
export async function putSandbox(
  ctx: TenantContext,
  id: string,
  body: PutSandboxRequest,
  scope: AuthScope,
): Promise<SandboxView> {
  const grants = sandboxGrantsOf(scope);
  reachable(grants, id);
  if (body.kind === "pod") await requirePods(ctx.pods, "A pod sandbox");
  const conflict = (field: string): never =>
    fail(
      409,
      `Sandbox ${id} exists with another ${field}. Its spec is fixed: delete it to create it again.`,
    );
  return ctx.store.tx(async (t) => {
    const now = new Date().toISOString();
    const config = await readSandboxConfig(t);
    const deleting = (row: SandboxResource | undefined) => {
      if (row && !live(row))
        fail(409, `Sandbox ${id} is being deleted. Try again once it is gone.`, {
          code: "sandbox_busy",
          details: { retryAfterSeconds: 5 },
        }, { "retry-after": "5" });
    };
    const found = async (existing: SandboxResource): Promise<SandboxView> => {
      const mismatch = specMismatch(existing, body);
      if (mismatch) conflict(mismatch);
      let current = existing;
      if (body.labels !== undefined && canonical(body.labels) !== canonical(existing.labels)) {
        await t.updateSandboxLabels(id, body.labels, now);
        current = { ...current, labels: body.labels, updatedAt: now };
      }
      const pod = current.pod;
      if (pod) {
        const spec = current.spec as PodSandboxSpec;
        const ttl = body.lifecycle?.ttl;
        let revive = false;
        if (ttl !== undefined && ttl !== spec.lifecycle?.ttl) {
          checkTtl(ttl, config.limits?.ttl);
          const next = { ...spec, lifecycle: { ...spec.lifecycle, ttl } } as SandboxManifest;
          const expiresAt = expiresAtOf(current.createdAt, ttl);
          await t.updateSandboxSpec(id, next, now);
          await t.updateSandboxPod(id, { expiresAt: expiresAt ?? null }, now);
          current = { ...current, spec: next, pod: { ...pod, ...(expiresAt ? { expiresAt } : {}) } };
          revive = pod.observed === "expired" && expiresAt !== undefined && Date.parse(expiresAt) > Date.now();
        }
        if (pod.observed === "lost")
          fail(409, `Sandbox ${id} was lost (${pod.reason ?? "its volume is gone"}). Reset it to continue.`, {
            code: "sandbox_lost",
          });
        if (revive || pod.desired !== "running" || pod.observed === "failed") {
          await wantRunning(t, current as SandboxResource & { pod: SandboxPodState }, now);
          reconcileAfter(ctx, t, id);
        }
        return viewOf(ctx, t, (await t.sandboxResource(id)) ?? current, ownerOf(scope));
      }
      return viewOf(ctx, t, current, ownerOf(scope));
    };
    const existing = await t.sandboxResource(id, { lock: true });
    deleting(existing);
    if (existing) return found(existing);
    const effective = effectiveSandboxConfig(config);
    const spec = resolveSpec(body, effective, config.limits?.ttl);
    const kind = body.kind ?? "virtual";
    const row: SandboxResource = {
      id,
      kind,
      spec,
      labels: body.labels ?? {},
      createdAt: now,
      updatedAt: now,
      ...(kind === "pod"
        ? {
            pod: {
              k8sName: podName(ctx.config.tenantId, id, 0),
              volumeGen: 0,
              desired: "running",
              observed: "creating",
              hostEpoch: 0,
              rev: 1,
              startedAt: now,
              lastActiveAt: now,
              ...(body.lifecycle?.ttl ? { expiresAt: expiresAtOf(now, body.lifecycle.ttl)! } : {}),
            } satisfies SandboxPodState,
          }
        : {}),
    };
    const created = await t.createSandboxResource(row, effective.limits.sandboxes);
    if (created === "limit")
      fail(409, `This Tenant allows at most ${effective.limits.sandboxes} sandboxes.`, {
        code: "limit_exceeded",
        details: { limit: "sandboxes", max: effective.limits.sandboxes },
      });
    if (created === "exists") {
      // Created by another request since the read above: answer as for an existing one.
      const again = (await t.sandboxResource(id, { lock: true })) ?? notFound();
      deleting(again);
      return found(again);
    }
    await t.sandboxEvent(id, "sandbox.created", { kind, labels: row.labels });
    if (row.pod) {
      // Created at once; idle from now if no turn comes.
      reconcileAfter(ctx, t, id);
      const idleAt = Date.parse(now) + podLifecycleConfig(config).idleMs;
      t.afterCommit(() => ctx.sandboxSignal(id, { kind: "arm", timer: "idle", at: idleAt }));
    }
    return viewOf(ctx, t, row, ownerOf(scope));
  });
}

/** `GET /v1/sandboxes/{id}`. */
export async function getSandbox(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<SandboxView> {
  reachable(sandboxGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    const sandbox = (await liveSandbox(t, id)) ?? notFound();
    return viewOf(ctx, t, sandbox, ownerOf(scope));
  });
}

/** `GET /v1/sandboxes?label=k=v`: every sandbox with all the labels, that the caller reaches. */
export async function listSandboxes(
  ctx: TenantContext,
  labels: Record<string, string>,
  scope: AuthScope,
): Promise<{ sandboxes: SandboxView[] }> {
  const grants = sandboxGrantsOf(scope);
  return ctx.store.tx(async (t) => {
    const found = await t.listSandboxResources({ labels });
    const views: SandboxView[] = [];
    for (const sandbox of found)
      if (live(sandbox) && (grants === undefined || sandboxGranted(grants, sandbox.id)))
        views.push(await viewOf(ctx, t, sandbox, ownerOf(scope)));
    return { sandboxes: views };
  });
}

/** Refused while a session attached to sandbox `id` has a turn running. */
async function refuseBusy(t: Tx, id: string): Promise<void> {
  const busy = (await t.sessionsOnSandbox<Session>(id)).some((session) => session.activeTurnId !== null);
  if (busy)
    fail(409, `Sandbox ${id} has a turn running. Cancel it, or wait for it to end.`, {
      code: "sandbox_busy",
    });
}

/**
 * `DELETE /v1/sandboxes/{id}`: deletes the sandbox and its workspace. Refused while a session
 * attached to it has an active turn. Sessions stay attached by id: their next turn is refused
 * (`sandbox_unavailable`) unless a sandbox with this id exists again. A pod sandbox's row stays
 * (`desired: deleted`) until its Sandbox is gone.
 */
export async function deleteSandbox(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<{ id: string; deleted: boolean }> {
  reachable(sandboxGrantsOf(scope), id);
  const deleted = await ctx.store.tx(async (t) => {
    const sandbox = await liveSandbox(t, id, { lock: true });
    if (!sandbox) return false;
    await refuseBusy(t, id);
    await t.sandboxEvent(id, "sandbox.deleted", {});
    if (sandbox.pod) {
      const epoch = sandbox.pod.hostEpoch + 1;
      await t.updateSandboxPod(
        id,
        { desired: "deleted", observed: "deleting", rev: sandbox.pod.rev + 1, hostEpoch: epoch },
        new Date().toISOString(),
      );
      reconcileAfter(ctx, t, id);
      t.afterCommit(() => ctx.harness.revokeHost(id, epoch));
    } else await t.deleteSandboxResource(id);
    return true;
  });
  // After the commit: a turn that starts now finds no sandbox and is refused.
  if (deleted) await ctx.sandbox.removeSandbox(id);
  return { id, deleted };
}

/** The pod sandbox `id` under the row lock, or a 404 or 400. */
async function podSandbox(t: Tx, id: string): Promise<SandboxResource & { pod: SandboxPodState }> {
  const sandbox = (await liveSandbox(t, id, { lock: true })) ?? notFound();
  if (!sandbox.pod) return fail(400, `Sandbox ${id} is virtual: only a pod sandbox stops and resets`);
  return sandbox as SandboxResource & { pod: SandboxPodState };
}

/**
 * `POST /v1/sandboxes/{id}/stop`: suspends a pod sandbox. Its volume is kept, and the next turn
 * of a session attached to it (or a `PUT`) starts it again. Refused during a turn.
 */
export async function stopSandbox(ctx: TenantContext, id: string, scope: AuthScope): Promise<SandboxView> {
  reachable(sandboxGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    const sandbox = await podSandbox(t, id);
    await refuseBusy(t, id);
    const pod = sandbox.pod;
    if (pod.desired === "running" && pod.observed !== "lost" && pod.observed !== "expired") {
      const now = new Date().toISOString();
      const epoch = pod.hostEpoch + 1;
      await t.updateSandboxPod(id, { desired: "suspended", rev: pod.rev + 1, hostEpoch: epoch }, now);
      await t.sandboxEvent(id, "sandbox.suspended", { reason: "stop" });
      reconcileAfter(ctx, t, id);
      t.afterCommit(() => ctx.harness.revokeHost(id, epoch));
    }
    return viewOf(ctx, t, (await t.sandboxResource(id)) ?? sandbox, ownerOf(scope));
  });
}

/**
 * `POST /v1/sandboxes/{id}/reset`: a new pod on a new, empty volume (the next volume
 * generation), with a new join token; the old Sandbox and volume are deleted. Leaves `lost` and
 * `failed`; an expired sandbox stays expired. Refused during a turn, and while an earlier
 * reset's Sandbox is still being deleted.
 */
export async function resetSandbox(ctx: TenantContext, id: string, scope: AuthScope): Promise<SandboxView> {
  reachable(sandboxGrantsOf(scope), id);
  await requirePods(ctx.pods, "Resetting a pod sandbox");
  return ctx.store.tx(async (t) => {
    const sandbox = await podSandbox(t, id);
    await refuseBusy(t, id);
    const pod = sandbox.pod;
    if (pod.retiring !== undefined)
      fail(409, `Sandbox ${id} is still deleting its previous volume. Try again shortly.`, {
        code: "sandbox_busy",
        details: { retryAfterSeconds: 5 },
      }, { "retry-after": "5" });
    const now = new Date().toISOString();
    const volumeGen = pod.volumeGen + 1;
    const epoch = pod.hostEpoch + 1;
    const expired = pod.expiresAt !== undefined && Date.parse(pod.expiresAt) <= Date.now();
    await t.updateSandboxPod(
      id,
      {
        k8sName: podName(ctx.config.tenantId, id, volumeGen),
        volumeGen,
        retiring: pod.k8sName,
        desired: "running",
        observed: expired ? "expired" : "creating",
        rev: pod.rev + 1,
        hostEpoch: epoch,
        joinTokenHash: null,
        podUid: null,
        startedAt: now,
        lastActiveAt: now,
        reason: null,
      },
      now,
    );
    await t.sandboxEvent(id, "sandbox.reset", { volumeGeneration: volumeGen });
    reconcileAfter(ctx, t, id);
    t.afterCommit(() => ctx.harness.revokeHost(id, epoch));
    return viewOf(ctx, t, (await t.sandboxResource(id)) ?? sandbox, ownerOf(scope));
  });
}

/** `GET /v1/sandboxes/{id}/events`: the sandbox's lifecycle stream. */
export async function sandboxEventsOf(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
  fromSeq: number | undefined,
) {
  reachable(sandboxGrantsOf(scope), id);
  return ctx.store.tx(async (t) => ({
    events: await t.sandboxEvents(id, fromSeq === undefined ? {} : { fromSeq }),
  }));
}

/**
 * Attaches a new session to sandbox `id` (`PutSessionRequest.sandbox = { id }`): the sandbox
 * must exist and be reachable with `grants`. Returns its spec, which the session pins. Runs in
 * the session's transaction, after its session row lock.
 */
export async function attachSandbox(
  t: Tx,
  id: string,
  grants: readonly string[] | undefined,
): Promise<SandboxResource> {
  reachable(grants, id);
  return (await liveSandbox(t, id, { lock: true })) ?? notFound();
}

/** Records the attachment on the session's log and on the sandbox's stream. */
export async function recordAttachment(t: Tx, sessionId: string, sandboxId: string) {
  await t.event(sessionId, null, "sandbox.attached", { sandboxId });
  await t.sandboxEvent(sandboxId, "sandbox.attached", { sessionId });
}

/**
 * Checks a turn start on a session attached to a sandbox, in the command's transaction after
 * the session row lock: the sandbox still exists, a subject token's `sbx` grants reach it, and
 * no other session attached to it has a turn running. Holds the sandbox row's lock until the
 * transaction ends, so two turn starts on one sandbox are decided one after the other.
 *
 * A pod sandbox must also be usable: not lost (`sandbox_lost`) or expired (`sandbox_expired`),
 * on a Runtime with sandbox pods (`sandbox_unavailable`). A stopped or failed pod is asked to
 * run again, after the commit.
 */
export async function checkSandboxTurn(
  t: Tx,
  session: Session,
  scope: AuthScope,
  ctx?: TenantContext,
): Promise<void> {
  const id = session.sandboxId;
  if (id === undefined) return;
  const grants = sandboxGrantsOf(scope);
  if (grants !== undefined && !sandboxGranted(grants, id))
    fail(403, `This token does not reach sandbox ${id}.`, { code: "sandbox_not_granted" });
  const sandbox = await liveSandbox(t, id, { lock: true });
  if (!sandbox)
    fail(409, `Sandbox ${id} was deleted. Create it again to continue this session.`, {
      code: "sandbox_unavailable",
    });
  const holder = (await t.sessionsOnSandbox<Session>(id)).find(
    (other) => other.id !== session.id && other.activeTurnId !== null,
  );
  if (holder)
    fail(409, `Sandbox ${id} is running another session's turn. Turns are serial per sandbox.`, {
      code: "sandbox_busy",
      details: { retryAfterSeconds: 5 },
    }, { "retry-after": "5" });
  const pod = sandbox?.pod;
  if (!pod) return;
  if (!ctx?.pods)
    fail(409, `Sandbox ${id} is a pod sandbox, and this Runtime has no sandbox pods: run \`nylorun sandbox enable --context <name>\`.`, {
      code: "sandbox_unavailable",
    });
  if (pod.observed === "lost")
    fail(409, `Sandbox ${id} was lost (${pod.reason ?? "its volume is gone"}). Reset it to continue.`, {
      code: "sandbox_lost",
    });
  if (pod.observed === "expired")
    fail(409, `Sandbox ${id} expired. PUT it with a longer lifecycle.ttl to revive it.`, {
      code: "sandbox_expired",
    });
  const now = new Date().toISOString();
  if (pod.desired !== "running" || pod.observed === "failed") {
    await wantRunning(t, sandbox as SandboxResource & { pod: SandboxPodState }, now);
    reconcileAfter(ctx!, t, id);
  } else await t.updateSandboxPod(id, { lastActiveAt: now }, now);
}

/** A sessions reset detaches every session from its sandbox: each sandbox's stream says so. */
export async function detachAllSessions(t: Tx): Promise<void> {
  for (const sandbox of await t.listSandboxResources()) {
    const sessions = await t.sessionsOnSandbox(sandbox.id);
    if (sessions.length === 0) continue;
    await t.sandboxResource(sandbox.id, { lock: true });
    for (const session of sessions)
      await t.sandboxEvent(sandbox.id, "sandbox.detached", {
        sessionId: session.id,
        reason: "reset",
      });
  }
}

/**
 * Marks the end of a turn's segment on pod sandbox `id`: idle counts from now, and the idle
 * timer is armed (D34). Best effort.
 */
export async function touchPodSandbox(ctx: TenantContext, id: string): Promise<void> {
  try {
    const at = await ctx.store.tx(async (t) => {
      const sandbox = await t.sandboxResource(id, { lock: true });
      if (!sandbox?.pod || sandbox.pod.desired !== "running") return undefined;
      const now = new Date();
      await t.updateSandboxPod(id, { lastActiveAt: now.toISOString() }, now.toISOString());
      return now.getTime() + podLifecycleConfig(await readSandboxConfig(t)).idleMs;
    });
    if (at !== undefined) await ctx.sandboxSignal(id, { kind: "arm", timer: "idle", at });
  } catch (error) {
    ctx.config.logger.warn("sandbox idle timer not armed", {
      sandboxId: id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
