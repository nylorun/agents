/**
 * Environments (D55, D56, protocol 11): `PUT`, `GET` and `DELETE /v1/environments/{id}`, the
 * list by label, stop, reset and the lifecycle stream; sessions naming one with `environment`,
 * and the checks every turn start makes on it.
 *
 * - **No scope.** The Runtime decides nothing about who uses an Environment: the app maps its
 *   people and agents to ids. It stores the id, kind, recipe, labels and the optional owner
 *   guard; the session body names the Environment (`Session.environmentId`), and deleting a
 *   session (a sessions reset) only detaches it.
 * - **One sandbox, one vault.** Kind `virtual` (a just-bash workspace in the harness container,
 *   keyed by the Environment id and created on the first tool call), `pod` (an agent-sandbox pod
 *   on the Tenant's cluster, Host feature `sandbox-pods`, created at once) or `none` (no compute).
 *   Each has one vault (`vault/service.ts`), created and deleted with it in one transaction.
 * - **A recipe that changes.** `PUT` on an existing id compares the fields sent: `kind` and
 *   `storage` are fixed (`409`), labels replace, and any other change writes the recipe and bumps
 *   `version`. A pod runs `applied`: image and resources reach it when it is next asked to run
 *   from stopped (`wantRunning`), so nothing swaps them mid-turn; so does `harness`, which picks
 *   what the pod runs (R4.4). Network and lifecycle apply at once. A virtual or `none`
 *   Environment applies every change at once.
 * - **Access.** An application key reaches every Environment, and so does an application key
 *   acting for a subject (`Nylorun-Subject`), which needs `environments:write` to change one. A
 *   token caller reaches only the ids its grants match, and changes them only with
 *   `environments:write`; any other id is the 404 of a missing one.
 * - **The owner guard.** When `ownerUserId` is set, only that owner's sessions may name the
 *   Environment, checked when a session opens and at every turn start (`403
 *   environment_owner_mismatch`; the opaque 404 to a caller acting for a person).
 * - **Serial turns.** One turn at a time per Environment with a sandbox: a session whose
 *   Environment another session's turn holds is refused (`409 environment_busy`).
 * - **Lifecycle.** `POST .../stop` suspends a pod (the volume is kept; the next turn starts it),
 *   `POST .../reset` gives it a new pod on a new volume. A lost pod refuses turns
 *   (`environment_lost`) until a reset. `lifecycle.deleteAfter` deletes an Environment unused
 *   for that long (the Tenant sweep, `sweepUnusedEnvironments`). Deleting a pod Environment keeps
 *   its row (`desired: deleted`, invisible here) until its Sandbox is gone; its vault goes at once.
 * - **Lifecycle events** go to the Environment's own stream in the record (`Tx.environmentEvent`,
 *   `record/environment.ts`); the session's log records `environment.attached` too.
 */
import {
  environmentGranted,
  type EnvironmentKind,
  type EnvironmentView,
  type PutEnvironmentRequest,
} from "@nylorun/core/contracts";
import { isWorkflowManifest, parseSandboxDuration } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import type { Environment, SandboxPodState, Tx } from "../store/types.js";
import { resolveRecipe, type RecipeRequest } from "../sandbox/resolve.js";
import { sandboxWorkspaceKey } from "../sandbox/records.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import { podName } from "../sandbox/pods/name.js";
import { podLifecycleConfig } from "../sandbox/pods/spec.js";
import { requirePods } from "../sandbox/placement.js";
import type { SandboxRouteDeps } from "../core/sandbox-routes.js";
import { harnessOf, sessionOf, type AuthScope, type Session, type TenantContext } from "./context.js";
import { fail } from "./http.js";

/** The Environment grants that limit `scope`, or undefined when it reaches every Environment. */
export function environmentGrantsOf(scope: AuthScope): readonly string[] | undefined {
  return scope.kind === "token" ? (scope.environments ?? []) : undefined;
}

/** The subject a request acts for, when it acts for one. */
function subjectOf(scope: AuthScope): string | undefined {
  return scope.kind === "token" || scope.kind === "subject" ? scope.subject : undefined;
}

/** Who the vault's audit rows name for a request: the subject, else the application. */
export function actorOf(scope: AuthScope): string {
  return subjectOf(scope) ?? "application";
}

const notFound = (): never => fail(404, "Environment not found");

/** The Environment, when `grants` reach it; otherwise the 404 of a missing one. */
function reachable(grants: readonly string[] | undefined, id: string): void {
  if (grants !== undefined && !environmentGranted(grants, id)) notFound();
}

/** Refuses (the 404 of a missing one) Environment `id` when the caller's grants miss it. */
export function assertReaches(scope: AuthScope, id: string): void {
  reachable(environmentGrantsOf(scope), id);
}

/** A pod Environment being deleted is no longer an Environment, here. */
function live(row: Environment | undefined): Environment | undefined {
  return row?.pod?.desired === "deleted" ? undefined : row;
}

/** An Environment, unless it is gone or being deleted. */
export async function liveEnvironment(
  t: Tx,
  id: string,
  options: { lock?: boolean } = {},
): Promise<Environment | undefined> {
  return live(await t.environment(id, options));
}

/** The compute state a pod's view reports. */
function podState(pod: SandboxPodState): string {
  if (pod.observed === "running") return "running";
  if (pod.observed === "creating") return "creating";
  return "stopped";
}

async function viewOf(
  ctx: TenantContext,
  t: Tx,
  environment: Environment,
  owner: string | undefined,
): Promise<EnvironmentView> {
  const sessions = await t.sessionsOnEnvironment<Session>(environment.id);
  const record =
    environment.kind === "virtual"
      ? await t.get<{ state?: string }>(
          "sandboxes",
          sandboxWorkspaceKey(ctx.config.tenantId, environment.id),
        )
      : undefined;
  const pod = environment.pod;
  return {
    id: environment.id,
    kind: environment.kind,
    labels: environment.labels,
    recipe: environment.recipe,
    version: environment.version,
    appliedVersion: environment.appliedVersion,
    ownerUserId: environment.ownerUserId ?? null,
    state: pod ? podState(pod) : environment.kind === "none" ? "ready" : (record?.state ?? "ready"),
    ...(pod
      ? {
          pod: {
            desired: pod.desired,
            observed: pod.observed,
            volumeGeneration: pod.volumeGen,
            hostEpoch: pod.hostEpoch,
            ...(pod.reason ? { reason: pod.reason } : {}),
          },
        }
      : {}),
    lastUsedAt: environment.lastUsedAt,
    sessions: sessions
      .filter((session) => owner === undefined || session.ownerUserId === owner)
      .map((session) => ({ id: session.id, activeTurnId: session.activeTurnId })),
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

/** What a `PUT` asks of the recipe: its fields over `existing`'s (fixed `storage` kept). */
function recipeRequest(body: PutEnvironmentRequest, existing?: Environment): RecipeRequest {
  const recipe = existing?.recipe;
  const pick = <K extends keyof RecipeRequest>(key: K, sent: RecipeRequest[K]) =>
    sent !== undefined ? { [key]: sent } : recipe?.[key] !== undefined ? { [key]: recipe[key] } : {};
  return {
    ...pick("image", body.image),
    ...pick("resources", body.resources),
    ...(recipe?.storage !== undefined
      ? { storage: recipe.storage }
      : body.storage !== undefined
        ? { storage: body.storage }
        : {}),
    ...pick("network", body.network),
    ...pick("harness", body.harness),
    ...pick("lifecycle", body.lifecycle),
  };
}

/** Refuses an owner guard a caller acting for a person may not set. */
function checkGuard(scope: AuthScope, asked: string | null | undefined, current?: string): void {
  const subject = subjectOf(scope);
  if (subject === undefined || asked === undefined) return;
  if (asked === null ? (current !== undefined && current !== subject) : asked !== subject)
    fail(403, "A request acting for a person may set ownerUserId only to that person.");
}

/** Asks for a pod's reconcile once the transaction commits (the sandbox signal outbox). */
function reconcileAfter(t: Tx, id: string): Promise<void> {
  return t.signalSandbox(id, { kind: "reconcile" });
}

/** Tells every process that pod Environment `id`'s host epoch moved to `epoch`, at commit. */
function revokeHost(t: Tx, id: string, epoch: number): Promise<void> {
  return t.signal({ type: "host.revoked", sandboxId: id, epoch });
}

type PodEnvironment = Environment & { pod: SandboxPodState };

/**
 * Asks the pod to run (again), with the recipe applied: a new `rev`, so the service applies it.
 * Only a stopped or failed pod is asked, so image and resources never change mid-turn (Q8).
 */
async function wantRunning(t: Tx, environment: PodEnvironment, now: string): Promise<void> {
  if (environment.appliedVersion !== environment.version)
    await t.updateEnvironment(
      environment.id,
      { applied: environment.recipe, appliedVersion: environment.version },
      now,
    );
  await t.updateEnvironmentPod(
    environment.id,
    {
      desired: "running",
      rev: environment.pod.rev + 1,
      observed: "creating",
      startedAt: now,
      lastActiveAt: now,
      reason: null,
    },
    now,
  );
}

/**
 * `PUT /v1/environments/{id}`: creates the Environment and its vault (within the Tenant's limit
 * on their number), or finds the one with this id, so "get or create" is one call. On an
 * existing one, `kind` and `storage` must match, labels replace, the owner guard is set or
 * cleared, and a recipe change bumps `version`. Every `PUT` counts as the Environment's use.
 */
export async function putEnvironment(
  ctx: TenantContext,
  id: string,
  body: PutEnvironmentRequest,
  scope: AuthScope,
): Promise<EnvironmentView> {
  reachable(environmentGrantsOf(scope), id);
  if (body.kind === "pod") await requirePods(ctx.pods, "A pod Environment");
  const conflict = (field: string): never =>
    fail(
      409,
      `Environment ${id} exists with another ${field}, which is fixed: delete it to create it again.`,
    );
  return ctx.store.tx(async (t) => {
    const now = new Date().toISOString();
    const config = effectiveSandboxConfig(await readSandboxConfig(t));
    const resolve = (kind: EnvironmentKind, request: RecipeRequest) => {
      const resolved = resolveRecipe(kind, request, config);
      return resolved.kind === "error" ? fail(400, resolved.errors.join(" ")) : resolved.recipe;
    };
    const deleting = (row: Environment | undefined) => {
      if (row && !live(row))
        fail(409, `Environment ${id} is being deleted. Try again once it is gone.`, {
          code: "environment_busy",
          details: { retryAfterSeconds: 5 },
        }, { "retry-after": "5" });
    };
    const found = async (existing: Environment): Promise<EnvironmentView> => {
      if (body.kind !== undefined && body.kind !== existing.kind) conflict("kind");
      if (body.storage !== undefined && body.storage !== existing.recipe.storage) conflict("storage");
      checkGuard(scope, body.ownerUserId, existing.ownerUserId);
      const recipe = resolve(existing.kind, recipeRequest(body, existing));
      const patch: Parameters<Tx["updateEnvironment"]>[1] = { lastUsedAt: now };
      if (body.labels !== undefined && canonical(body.labels) !== canonical(existing.labels))
        patch.labels = body.labels;
      if (body.ownerUserId !== undefined && (body.ownerUserId ?? undefined) !== existing.ownerUserId)
        patch.ownerUserId = body.ownerUserId;
      if (canonical(recipe) !== canonical(existing.recipe)) {
        const version = existing.version + 1;
        patch.recipe = recipe;
        patch.version = version;
        // The harness is what a pod runs (R4.4): it changes with the pod, like its image.
        const compute = (r: typeof recipe) =>
          canonical({ image: r.image ?? null, resources: r.resources ?? null, harness: r.harness });
        if (existing.kind !== "pod" || compute(recipe) === compute(existing.applied)) {
          // Nothing waits for a wake: apply all of it.
          patch.applied = recipe;
          patch.appliedVersion = version;
        } else
          // Network and lifecycle apply at once; image, resources and harness at the next wake.
          patch.applied = {
            ...existing.applied,
            ...(recipe.network === undefined ? {} : { network: recipe.network }),
            lifecycle: recipe.lifecycle,
          };
      }
      await t.updateEnvironment(id, patch, now);
      if (patch.recipe !== undefined && existing.pod?.desired === "running")
        // A new `lifecycle.idle` applies to the running pod's idle timer.
        await t.signalSandbox(id, {
          kind: "arm",
          timer: "idle",
          at:
            Date.parse(existing.pod.lastActiveAt ?? existing.createdAt) +
            podLifecycleConfig(await readSandboxConfig(t), patch.recipe).idleMs,
        });
      return viewOf(ctx, t, (await t.environment(id)) ?? existing, subjectOf(scope));
    };
    const existing = await t.environment(id, { lock: true });
    deleting(existing);
    if (existing) return found(existing);
    checkGuard(scope, body.ownerUserId);
    const kind = body.kind ?? "virtual";
    const recipe = resolve(kind, recipeRequest(body));
    const row: Environment = {
      id,
      kind,
      labels: body.labels ?? {},
      recipe,
      applied: recipe,
      version: 1,
      appliedVersion: 1,
      ...(body.ownerUserId ? { ownerUserId: body.ownerUserId } : {}),
      lastUsedAt: now,
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
            } satisfies SandboxPodState,
          }
        : {}),
    };
    const created = await t.createEnvironment(row, config.limits.environments);
    if (created === "limit")
      fail(409, `This Tenant allows at most ${config.limits.environments} Environments.`, {
        code: "limit_exceeded",
        details: { limit: "environments", max: config.limits.environments },
      });
    if (created === "exists") {
      // Created by another request since the read above: answer as for an existing one.
      const again = (await t.environment(id, { lock: true })) ?? notFound();
      deleting(again);
      return found(again);
    }
    await ctx.vault.createEnvironmentVault(t, id, actorOf(scope));
    await t.environmentEvent(id, "environment.created", { kind, labels: row.labels });
    if (row.pod) {
      // Created at once; idle from now if no turn comes.
      await reconcileAfter(t, id);
      const idleAt = Date.parse(now) + podLifecycleConfig(await readSandboxConfig(t), recipe).idleMs;
      await t.signalSandbox(id, { kind: "arm", timer: "idle", at: idleAt });
    }
    return viewOf(ctx, t, row, subjectOf(scope));
  });
}

/** `GET /v1/environments/{id}`. */
export async function getEnvironment(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<EnvironmentView> {
  reachable(environmentGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    const environment = (await liveEnvironment(t, id)) ?? notFound();
    return viewOf(ctx, t, environment, subjectOf(scope));
  });
}

/** `GET /v1/environments?label=k=v`: every Environment with all the labels, that the caller reaches. */
export async function listEnvironments(
  ctx: TenantContext,
  labels: Record<string, string>,
  scope: AuthScope,
): Promise<{ environments: EnvironmentView[] }> {
  const grants = environmentGrantsOf(scope);
  return ctx.store.tx(async (t) => {
    const found = await t.listEnvironments({ labels });
    const views: EnvironmentView[] = [];
    for (const environment of found)
      if (live(environment) && (grants === undefined || environmentGranted(grants, environment.id)))
        views.push(await viewOf(ctx, t, environment, subjectOf(scope)));
    return { environments: views };
  });
}

/** Refused while a session that names Environment `id` has a turn running. */
async function refuseBusy(t: Tx, id: string): Promise<void> {
  const busy = (await t.sessionsOnEnvironment<Session>(id)).some(
    (session) => session.activeTurnId !== null,
  );
  if (busy)
    fail(409, `Environment ${id} has a turn running. Cancel it, or wait for it to end.`, {
      code: "environment_busy",
      details: { retryAfterSeconds: 5 },
    }, { "retry-after": "5" });
}

/**
 * Deletes `environment` (locked, live) in `t`: its vault and credentials at once, its workspace
 * after the commit (the caller's), and the row, or for a pod, the row once its Sandbox is gone.
 */
async function deleteIn(
  ctx: TenantContext,
  t: Tx,
  environment: Environment,
  actor: string,
  reason: "delete" | "deleteAfter",
): Promise<void> {
  const id = environment.id;
  await t.environmentEvent(id, "environment.deleted", { reason });
  await ctx.vault.deleteEnvironmentVault(t, id, actor);
  if (environment.pod) {
    const epoch = environment.pod.hostEpoch + 1;
    await t.updateEnvironmentPod(
      id,
      { desired: "deleted", observed: "deleting", rev: environment.pod.rev + 1, hostEpoch: epoch },
      new Date().toISOString(),
    );
    await reconcileAfter(t, id);
    await revokeHost(t, id, epoch);
  } else await t.deleteEnvironment(id);
}

/**
 * `DELETE /v1/environments/{id}`: deletes the Environment, its vault and its workspace. Refused
 * while a session that names it has an active turn. Sessions keep its id: their next turn is
 * refused (`environment_unavailable`) unless an Environment with this id exists again.
 */
export async function deleteEnvironment(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<{ id: string; deleted: boolean }> {
  reachable(environmentGrantsOf(scope), id);
  const deleted = await ctx.store.tx(async (t) => {
    const environment = await liveEnvironment(t, id, { lock: true });
    if (!environment) return false;
    await refuseBusy(t, id);
    await deleteIn(ctx, t, environment, actorOf(scope), "delete");
    return true;
  });
  // After the commit: a turn that starts now finds no Environment and is refused.
  if (deleted) await ctx.sandbox.removeSandbox(id);
  return { id, deleted };
}

/**
 * Deletes every Environment unused for its `lifecycle.deleteAfter` (Q13): no turn, recipe
 * change, secret write, stop or reset since. One with a turn running waits for the next sweep.
 * Run by the Tenant sweep.
 */
export async function sweepUnusedEnvironments(ctx: TenantContext, now = Date.now()): Promise<void> {
  const due = (await ctx.store.tx((t) => t.listEnvironments())).filter((environment) => {
    const after = environment.recipe.lifecycle.deleteAfter;
    const ms = after === undefined ? undefined : parseSandboxDuration(after);
    return live(environment) && ms !== undefined && Date.parse(environment.lastUsedAt) + ms <= now;
  });
  for (const candidate of due) {
    try {
      const deleted = await ctx.store.tx(async (t) => {
        const environment = await liveEnvironment(t, candidate.id, { lock: true });
        const after = environment?.recipe.lifecycle.deleteAfter;
        const ms = after === undefined ? undefined : parseSandboxDuration(after);
        if (!environment || ms === undefined || Date.parse(environment.lastUsedAt) + ms > now) return false;
        const busy = (await t.sessionsOnEnvironment<Session>(environment.id)).some(
          (session) => session.activeTurnId !== null,
        );
        if (busy) return false;
        await deleteIn(ctx, t, environment, "sweep", "deleteAfter");
        return true;
      });
      if (deleted) {
        await ctx.sandbox.removeSandbox(candidate.id);
        ctx.config.logger.info("environment deleted after lifecycle.deleteAfter", {
          environmentId: candidate.id,
        });
      }
    } catch (error) {
      ctx.config.logger.warn("environment deleteAfter failed", {
        environmentId: candidate.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** The pod Environment `id` under the row lock, or a 404 or 400. */
async function podEnvironment(t: Tx, id: string): Promise<PodEnvironment> {
  const environment = (await liveEnvironment(t, id, { lock: true })) ?? notFound();
  if (!environment.pod)
    return fail(400, `Environment ${id} is of kind ${environment.kind}: only a pod Environment stops and resets`);
  return environment as PodEnvironment;
}

/**
 * `POST /v1/environments/{id}/stop`: suspends a pod Environment. Its volume is kept, and the next
 * turn of a session that names it starts it again. Refused during a turn.
 */
export async function stopEnvironment(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<EnvironmentView> {
  reachable(environmentGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    const environment = await podEnvironment(t, id);
    await refuseBusy(t, id);
    const pod = environment.pod;
    const now = new Date().toISOString();
    if (pod.desired === "running" && pod.observed !== "lost") {
      const epoch = pod.hostEpoch + 1;
      await t.updateEnvironmentPod(id, { desired: "suspended", rev: pod.rev + 1, hostEpoch: epoch }, now);
      await t.environmentEvent(id, "environment.suspended", { reason: "stop" });
      await reconcileAfter(t, id);
      await revokeHost(t, id, epoch);
    }
    await t.updateEnvironment(id, { lastUsedAt: now }, now);
    return viewOf(ctx, t, (await t.environment(id)) ?? environment, subjectOf(scope));
  });
}

/**
 * `POST /v1/environments/{id}/reset`: a new pod on a new, empty volume (the next volume
 * generation), with a new join token and the recipe applied; the old Sandbox and volume are
 * deleted. Leaves `lost` and `failed`. Refused during a turn, and while an earlier reset's
 * Sandbox is still being deleted.
 */
export async function resetEnvironment(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<EnvironmentView> {
  reachable(environmentGrantsOf(scope), id);
  // A missing Environment is a 404, and one of another kind a 400, with or without sandbox pods.
  await ctx.store.tx((t) => podEnvironment(t, id));
  await requirePods(ctx.pods, "Resetting a pod Environment");
  return ctx.store.tx(async (t) => {
    const environment = await podEnvironment(t, id);
    await refuseBusy(t, id);
    const pod = environment.pod;
    if (pod.retiring !== undefined)
      fail(409, `Environment ${id} is still deleting its previous volume. Try again shortly.`, {
        code: "environment_busy",
        details: { retryAfterSeconds: 5 },
      }, { "retry-after": "5" });
    const now = new Date().toISOString();
    const volumeGen = pod.volumeGen + 1;
    const epoch = pod.hostEpoch + 1;
    await t.updateEnvironment(
      id,
      { applied: environment.recipe, appliedVersion: environment.version, lastUsedAt: now },
      now,
    );
    await t.updateEnvironmentPod(
      id,
      {
        k8sName: podName(ctx.config.tenantId, id, volumeGen),
        volumeGen,
        retiring: pod.k8sName,
        desired: "running",
        observed: "creating",
        rev: pod.rev + 1,
        hostEpoch: epoch,
        joinTokenHash: null,
        podUid: null,
        volumeId: null,
        startedAt: now,
        lastActiveAt: now,
        reason: null,
      },
      now,
    );
    await t.environmentEvent(id, "environment.reset", { volumeGeneration: volumeGen });
    await reconcileAfter(t, id);
    await revokeHost(t, id, epoch);
    return viewOf(ctx, t, (await t.environment(id)) ?? environment, subjectOf(scope));
  });
}

/** `GET /v1/environments/{id}/events`: the Environment's lifecycle stream. */
export async function environmentEventsOf(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
  fromSeq: number | undefined,
) {
  reachable(environmentGrantsOf(scope), id);
  return ctx.store.tx(async (t) => ({
    events: await t.environmentEvents(id, fromSeq === undefined ? {} : { fromSeq }),
  }));
}

/**
 * The owner guard (Q7): refuses a session of `ownerUserId` on an Environment guarded for
 * another owner. A caller acting for a person (`opaque`) gets the 404 of a missing one.
 */
function checkOwner(environment: Environment, ownerUserId: string, opaque: boolean): void {
  if (environment.ownerUserId === undefined || environment.ownerUserId === ownerUserId) return;
  if (opaque) notFound();
  fail(
    403,
    `Environment ${environment.id} is for another owner's sessions (its ownerUserId guard).`,
    { code: "environment_owner_mismatch" },
  );
}

/**
 * Opens a new session on Environment `id` (`PutSessionRequest.environment`): it must exist, be
 * reachable with `grants` and pass its owner guard. Runs in the session's transaction, after
 * its session row lock; holds the Environment's row lock.
 */
export async function openEnvironment(
  t: Tx,
  id: string,
  options: { grants?: readonly string[]; ownerUserId: string; opaque: boolean },
): Promise<Environment> {
  reachable(options.grants, id);
  const environment = (await liveEnvironment(t, id, { lock: true })) ?? notFound();
  checkOwner(environment, options.ownerUserId, options.opaque);
  return environment;
}

/** Records the attachment on the session's log and on the Environment's stream. */
export async function recordAttachment(t: Tx, sessionId: string, environmentId: string) {
  await t.event(sessionId, null, "environment.attached", { environmentId });
  await t.environmentEvent(environmentId, "environment.attached", { sessionId });
}

/**
 * Checks a turn start on a session that names an Environment, in the command's transaction
 * after the session row lock: the Environment still exists, a token caller's grants reach it,
 * its owner guard admits the session's owner, and, with a sandbox, no other session's turn
 * holds it. Holds the Environment row's lock until the transaction ends, so two turn starts on
 * one Environment are decided one after the other.
 *
 * A pod Environment must also be usable: not lost (`environment_lost`), on a Runtime with
 * sandbox pods (`environment_unavailable`). A stopped or failed pod is asked to run again, with
 * its recipe applied, after the commit.
 */
export async function checkEnvironmentTurn(
  t: Tx,
  session: Session,
  scope: AuthScope,
  ctx?: TenantContext,
): Promise<void> {
  const id = session.environmentId;
  if (id === undefined) return;
  const grants = environmentGrantsOf(scope);
  if (grants !== undefined && !environmentGranted(grants, id))
    fail(403, `This token does not reach Environment ${id}.`, { code: "environment_not_granted" });
  const environment = await liveEnvironment(t, id, { lock: true });
  if (!environment)
    return fail(409, `Environment ${id} was deleted. Create it again to continue this session.`, {
      code: "environment_unavailable",
    });
  if (environment.ownerUserId !== undefined && environment.ownerUserId !== session.ownerUserId)
    fail(403, `Environment ${id} is for another owner's sessions (its ownerUserId guard).`, {
      code: "environment_owner_mismatch",
    });
  // The harness the turn would run on (R4.1, Q9): a pod about to wake runs its recipe's. A
  // session never moves to another harness: its state is that harness's.
  const waking = environment.pod !== undefined && (environment.pod.desired !== "running" || environment.pod.observed === "failed");
  const runs = waking ? environment.recipe.harness : environment.applied.harness;
  if (!isWorkflowManifest(session.manifest) && runs !== harnessOf(session))
    fail(409, `Environment ${id} now runs the ${runs} harness, and this session runs ${harnessOf(session)}: open a new session to run on it.`, {
      code: "harness_mismatch",
      details: { harness: harnessOf(session), environmentHarness: runs },
    });
  if (environment.kind === "none") return;
  // A flow tree's sessions nest their turns in its root's: one holder.
  const tree = session.flowRootId ?? session.id;
  const holder = (await t.sessionsOnEnvironment<Session>(id)).find(
    (other) =>
      other.id !== session.id && other.activeTurnId !== null && (other.flowRootId ?? other.id) !== tree,
  );
  if (holder)
    fail(409, `Environment ${id} is running another session's turn. Turns are serial per Environment.`, {
      code: "environment_busy",
      details: { retryAfterSeconds: 5 },
    }, { "retry-after": "5" });
  const pod = environment.pod;
  if (!pod) return;
  if (!ctx?.pods)
    fail(409, `Environment ${id} is a pod Environment, and this Runtime has no sandbox pods: run \`nylorun sandbox enable --context <name>\`.`, {
      code: "environment_unavailable",
    });
  if (pod.observed === "lost")
    fail(409, `Environment ${id} was lost (${pod.reason ?? "its volume is gone"}). Reset it to continue.`, {
      code: "environment_lost",
    });
  const now = new Date().toISOString();
  if (pod.desired !== "running" || pod.observed === "failed") {
    await wantRunning(t, environment as PodEnvironment, now);
    await reconcileAfter(t, id);
  } else await t.updateEnvironmentPod(id, { lastActiveAt: now }, now);
}

/** A sessions reset detaches every session from its Environment: each one's stream says so. */
export async function detachAllSessions(t: Tx): Promise<void> {
  for (const environment of await t.listEnvironments()) {
    const sessions = await t.sessionsOnEnvironment(environment.id);
    if (sessions.length === 0) continue;
    await t.environment(environment.id, { lock: true });
    for (const session of sessions)
      await t.environmentEvent(environment.id, "environment.detached", {
        sessionId: session.id,
        reason: "reset",
      });
  }
}

/**
 * Marks the end of a turn's segment on Environment `id`: it was used now (`deleteAfter` counts
 * from here), and for a running pod idle counts from now and the idle timer is armed (D34).
 * Best effort.
 */
export async function touchEnvironment(ctx: TenantContext, id: string): Promise<void> {
  try {
    await ctx.store.tx(async (t) => {
      const environment = await liveEnvironment(t, id, { lock: true });
      if (!environment) return;
      const now = new Date();
      const iso = now.toISOString();
      await t.updateEnvironment(id, { lastUsedAt: iso }, iso);
      if (!environment.pod || environment.pod.desired !== "running") return;
      await t.updateEnvironmentPod(id, { lastActiveAt: iso }, iso);
      const idleMs = podLifecycleConfig(await readSandboxConfig(t), environment.recipe).idleMs;
      await t.signalSandbox(id, { kind: "arm", timer: "idle", at: now.getTime() + idleMs });
    });
  } catch (error) {
    ctx.config.logger.warn("environment use not recorded", {
      environmentId: id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-arms the idle timer of every running pod after the Tenant's settings change, so a shorter
 * `limits.idle` applies to pods already idle (D36: the settings are read whenever a timer is
 * set). Best effort.
 */
export async function rearmPodTimers(ctx: TenantContext): Promise<void> {
  if (!ctx.pods) return;
  try {
    const { rows, config } = await ctx.store.tx(async (t) => ({
      rows: await t.listEnvironments(),
      config: await readSandboxConfig(t),
    }));
    for (const row of rows)
      if (row.pod?.desired === "running")
        await ctx.sandboxSignal(row.id, {
          kind: "arm",
          timer: "idle",
          at: Date.parse(row.pod.lastActiveAt ?? row.createdAt) + podLifecycleConfig(config, row.recipe).idleMs,
        });
  } catch (error) {
    ctx.config.logger.warn("pod idle timers not re-armed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Session lookups for the sandbox route handlers (`core/sandbox-routes.ts`). */
export function sandboxRouteDeps(ctx: TenantContext): SandboxRouteDeps {
  return {
    sandbox: ctx.sandbox,
    session: (id) => ctx.store.tx((t) => sessionOf(t, id)),
  };
}
