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
 * - **Made once, never changed** (protocol 14, D63). An Environment is made from one version of
 *   an environment manifest (`manifest: "name"` or `"name@n"`, `environment-manifests.ts`) or
 *   from an inline manifest (the fields of the `PUT`, its `recipe`), and keeps what it runs for
 *   life: a `PUT` on an existing id may change its labels and owner guard, a field that matches
 *   what it runs is accepted (so get-or-create stays one call), and anything else is
 *   `409 environment_immutable`, naming the fork that makes a new Environment instead.
 *   `version` and `appliedVersion` stay 1 for an Environment made since then.
 * - **Secret slots** (D64): when what it runs declares `secrets`, a secret write sends only the
 *   value, the binding comes from the slot, and a name it does not declare is
 *   `409 secret_not_in_manifest` (`secretRequestFor`).
 * - **Access.** An application key reaches every Environment, and so does an application key
 *   acting for a subject (`Nylorun-Subject`), which needs `environments:write` to change one. A
 *   token caller reaches only the ids its grants match, and changes them only with
 *   `environments:write`; any other id is the 404 of a missing one.
 * - **The owner guard.** When `ownerUserId` is set, only that owner's sessions may name the
 *   Environment, checked when a session opens and at every turn start (`403
 *   environment_owner_mismatch`; the opaque 404 to a caller acting for a person).
 * - **Parallel turns (D66).** Sessions on one Environment run their turns at the same time and
 *   share its `/workspace`; one turn per session stays. Which sessions work on one disk, and when,
 *   is the app's call. Disk work (snapshot, restore, stop, reset) waits until no turn runs
 *   (`409 environment_busy`), and a turn waits while a seed copies a disk.
 * - **Lifecycle.** `POST .../stop` suspends a pod (the volume is kept; the next turn starts it),
 *   `POST .../reset` gives it a new pod on a new volume. A lost pod refuses turns
 *   (`environment_lost`) until a reset. `lifecycle.deleteAfter` deletes an Environment unused
 *   for that long (the Tenant sweep, `sweepUnusedEnvironments`). Deleting a pod Environment keeps
 *   its row (`desired: deleted`, invisible here) until its Sandbox is gone; its vault goes at once.
 * - **Lifecycle events** go to the Environment's own stream in the record (`Tx.environmentEvent`,
 *   `record/environment.ts`); the session's log records `environment.attached` too.
 */
import { randomUUID } from "node:crypto";
import {
  environmentGranted,
  parseEnvironmentManifestRef,
  PutEnvironmentSecretRequestSchema,
  PutEnvironmentSecretValueRequestSchema,
  type EnvironmentForkPlan,
  type EnvironmentKind,
  type EnvironmentRecipe,
  type EnvironmentSecretSlot,
  type EnvironmentView,
  type ForkEnvironmentRequest,
  type ForkEnvironmentResponse,
  type PutEnvironmentRequest,
  type PutEnvironmentSecretRequest,
} from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import { isWorkflowManifest, parseSandboxDuration } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import type { Environment, EnvironmentEventsQuery, SandboxPodState, Tx } from "../store/types.js";
import { resolveRecipe, type RecipeRequest } from "../sandbox/resolve.js";
import { sandboxWorkspaceKey } from "../sandbox/records.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import { podName } from "../sandbox/pods/name.js";
import { podLifecycleConfig } from "../sandbox/pods/spec.js";
import { SETUP_FAILED } from "../sandbox/pods/lifecycle.js";
import { requirePods } from "../sandbox/placement.js";
import type { SandboxRouteDeps } from "../core/sandbox-routes.js";
import { deleteDiskArtifact, forkSeedOf, runPendingSeed, snapshotEnvironment } from "../artifacts/disk.js";
import { manifestChanges, manifestRecipeRequest } from "./environment-manifests.js";
import { labelIssues, limitIssues, limitsInForce, manifestShapeIssues, readTenantLimits } from "./limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { harnessOf, sessionOf, type AuthScope, type Session, type TenantContext } from "./context.js";
import { fail } from "./http.js";
import type { SealedSecretCopies } from "../vault/service.js";

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
  const slots = await slotsOf(t, environment);
  return {
    id: environment.id,
    kind: environment.kind,
    labels: environment.labels,
    manifest: environment.recipe,
    ...(environment.manifestName === undefined ? {} : { manifestName: environment.manifestName }),
    ...(environment.manifestVersion === undefined ? {} : { manifestVersion: environment.manifestVersion }),
    ...(environment.manifestHash === undefined ? {} : { manifestHash: environment.manifestHash }),
    limits: limitsInForce(await readTenantLimits(t), environment.applied.limits),
    ...(environment.forkedFrom === undefined ? {} : { forkedFrom: environment.forkedFrom }),
    ...(slots === undefined ? {} : { slots }),
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
            ...(pod.imageDigest ? { imageDigest: pod.imageDigest } : {}),
          },
        }
      : {}),
    lastUsedAt: environment.lastUsedAt,
    ...(environment.kind === "none"
      ? {}
      : {
          disk: {
            latestVersion: (await t.diskArtifact(environment.id))?.latestVersion || null,
            ...(diskHeld(environment)
              ? {
                  operation: {
                    kind: environment.diskOp!.kind,
                    ...(environment.diskOp!.version === undefined ? {} : { version: environment.diskOp!.version }),
                    startedAt: environment.diskOp!.startedAt,
                  },
                }
              : {}),
          },
        }),
    sessions: sessions
      .filter((session) => owner === undefined || session.ownerUserId === owner)
      .map((session) => ({ id: session.id, activeTurnId: session.activeTurnId })),
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

/** Each secret slot `environment` declares, and whether its vault holds a value for it. */
async function slotsOf(t: Tx, environment: Environment): Promise<EnvironmentView["slots"]> {
  const declared = environment.recipe.secrets;
  if (declared === undefined) return undefined;
  const vault = await t.vaultOfEnvironment(environment.id);
  const held = new Set(vault ? (await t.credentialsForVault(vault.id)).map((row) => row.name) : []);
  return Object.entries(declared)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, slot]) => ({ name, type: slot.type, required: slot.required ?? false, set: held.has(name) }));
}

/** The inline fields of a `PUT`: what it would run, besides labels, owner and `from`. */
const INLINE_FIELDS = [
  "kind",
  "image",
  "resources",
  "storage",
  "network",
  "harness",
  "lifecycle",
  "setup",
  "files",
  "limits",
  "secrets",
] as const satisfies readonly (keyof PutEnvironmentRequest)[];

/** The hash of what an Environment runs, recorded when it is made. */
function recipeHash(recipe: EnvironmentRecipe): string {
  return hashManifest(recipe as never);
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
    ...pick("setup", body.setup),
    ...pick("files", body.files),
    ...pick("limits", body.limits),
    ...pick("secrets", body.secrets),
  };
}

/**
 * Why input files cannot be used: each that is not a version of a Tenant-wide artifact (a
 * session's artifacts go with the session). Pins nothing else: the version is the one named.
 */
export async function fileErrors(t: Tx, files: EnvironmentRecipe["files"]): Promise<string[]> {
  const errors: string[] = [];
  for (const file of files ?? []) {
    if ("files" in file) {
      // Files by hash (Q6): each a definition file the Tenant holds.
      const wanted = [...new Set(Object.values(file.files))];
      const held = await t.heldDefinitionFiles(wanted);
      for (const [path, sha256] of Object.entries(file.files))
        if (!held.has(sha256))
          errors.push(`files: ${file.path}/${path} names ${sha256}, which the Tenant does not hold: upload it first (PUT /v1/files/${sha256}).`);
      continue;
    }
    const artifact = await t.artifact(file.artifactId);
    if (!artifact || artifact.sessionId !== null)
      errors.push(`files: ${file.artifactId} is not an artifact of the Tenant (an artifact of a session cannot be one).`);
    else if (!(await t.artifactVersion(file.artifactId, file.version)))
      errors.push(`files: ${file.artifactId} has no version ${file.version}.`);
  }
  return errors;
}

/** Refuses input files that cannot be used (`fileErrors`). */
async function checkFiles(t: Tx, files: EnvironmentRecipe["files"]): Promise<void> {
  const errors = await fileErrors(t, files);
  if (errors.length > 0) fail(400, errors.join(" "));
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
 *
 * A pod that runs but whose disk setup failed (R2d step 2) with its recipe unchanged keeps its pod:
 * the failure is cleared and nothing applied, so its engine, which polls `GET host/setup` with its
 * host token, is told to run the setup again (a new apply would end that token).
 */
async function wantRunning(t: Tx, environment: PodEnvironment, now: string): Promise<void> {
  const pod = environment.pod;
  if (
    pod.desired === "running" &&
    pod.observed === "failed" &&
    pod.reason?.startsWith(SETUP_FAILED) &&
    environment.appliedVersion === environment.version
  ) {
    await t.updateEnvironmentPod(
      environment.id,
      { observed: "creating", startedAt: now, lastActiveAt: now, reason: null },
      now,
    );
    return;
  }
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
 * on their number) from an environment manifest's version or from the inline fields, or finds
 * the one with this id, so "get or create" is one call. An existing one never changes what it
 * runs (D63): its labels and owner guard may change, fields that match are accepted, and any
 * other difference is `409 environment_immutable`. Every `PUT` counts as the Environment's use.
 */
export async function putEnvironment(
  ctx: TenantContext,
  id: string,
  body: PutEnvironmentRequest,
  scope: AuthScope,
  options: { fork?: Fork } = {},
): Promise<EnvironmentView> {
  const fork = options.fork;
  reachable(environmentGrantsOf(scope), id);
  const ref = body.manifest === undefined ? undefined : parseEnvironmentManifestRef(body.manifest);
  if (body.manifest !== undefined) {
    if (ref === undefined) fail(400, "manifest is an environment manifest's name, or name@version such as analyst-box@3.");
    const inline = INLINE_FIELDS.filter((field) => body[field] !== undefined);
    if (inline.length > 0)
      fail(
        400,
        `An Environment made from manifest ${body.manifest} runs what the manifest says: send no ${inline.join(", ")} with it.`,
      );
  }
  if (body.kind === "pod") await requirePods(ctx.pods, "A pod Environment");
  const immutable = (fields: readonly string[], existing: Environment): never =>
    fail(
      409,
      `Environment ${id} exists and never changes what it runs (${fields.join(", ")} differ${fields.length === 1 ? "s" : ""}): fork it into a new Environment with POST /v1/environments/${encodeURIComponent(id)}/fork, or use another id.`,
      {
        code: "environment_immutable",
        details: {
          fields: [...fields],
          ...(existing.manifestName === undefined
            ? {}
            : { manifest: `${existing.manifestName}@${existing.manifestVersion}` }),
        },
      },
    );
  const view = await ctx.store.tx(async (t) => {
    const now = new Date().toISOString();
    const config = effectiveSandboxConfig(await readSandboxConfig(t));
    const tenantLimits = await readTenantLimits(t);
    const runtimeLimits = await readRuntimeLimits(t);
    // `limits` and the manifest's shape are checked against the Tenant's only when an Environment
    // is made: a get-or-create on one made before the Tenant lowered a limit still answers, and
    // the lower limit applies. Labels are checked whenever they are set.
    const labels = labelIssues(body.labels, runtimeLimits);
    if (labels.length > 0) fail(400, labels.join(" "));
    const resolve = (kind: EnvironmentKind, request: RecipeRequest, creating: boolean) => {
      const resolved = resolveRecipe(kind, request, config);
      const errors = [
        ...(resolved.kind === "error" ? resolved.errors : []),
        ...(creating ? [...limitIssues(request.limits, tenantLimits), ...manifestShapeIssues(request, runtimeLimits)] : []),
      ];
      return resolved.kind === "error" || errors.length > 0 ? fail(400, errors.join(" ")) : resolved.recipe;
    };
    const deleting = (row: Environment | undefined) => {
      if (row && !live(row))
        fail(409, `Environment ${id} is being deleted. Try again once it is gone.`, {
          code: "environment_busy",
          details: { retryAfterSeconds: 5 },
        }, { "retry-after": "5" });
    };
    const found = async (existing: Environment): Promise<EnvironmentView> => {
      if (fork !== undefined) fail(409, `Environment ${id} exists: a fork makes a new Environment, so name another id.`);
      if (body.from !== undefined)
        fail(409, `Environment ${id} exists: from applies only when a PUT creates one.`);
      if (ref !== undefined) {
        // A bare name matches the manifest it was made from, whatever its latest version is now.
        if (ref.name !== existing.manifestName) immutable(["manifest"], existing);
        if (ref.version !== undefined && ref.version !== existing.manifestVersion) immutable(["manifest"], existing);
      } else if (INLINE_FIELDS.some((field) => body[field] !== undefined)) {
        if (body.kind !== undefined && body.kind !== existing.kind) immutable(["kind"], existing);
        if (body.storage !== undefined && body.storage !== existing.recipe.storage) immutable(["storage"], existing);
        const recipe = resolve(existing.kind, recipeRequest(body, existing), false);
        const differing = (Object.keys({ ...recipe, ...existing.recipe }) as (keyof EnvironmentRecipe)[])
          .filter((field) => canonical(recipe[field]) !== canonical(existing.recipe[field]))
          .sort();
        if (differing.length > 0) immutable(differing, existing);
      }
      checkGuard(scope, body.ownerUserId, existing.ownerUserId);
      const patch: Parameters<Tx["updateEnvironment"]>[1] = { lastUsedAt: now };
      if (body.labels !== undefined && canonical(body.labels) !== canonical(existing.labels))
        patch.labels = body.labels;
      if (body.ownerUserId !== undefined && (body.ownerUserId ?? undefined) !== existing.ownerUserId)
        patch.ownerUserId = body.ownerUserId;
      await t.updateEnvironment(id, patch, now);
      return viewOf(ctx, t, (await t.environment(id)) ?? existing, subjectOf(scope));
    };
    const existing = await t.environment(id, { lock: true });
    deleting(existing);
    if (existing) return found(existing);
    checkGuard(scope, body.ownerUserId);
    const manifest =
      ref === undefined
        ? undefined
        : ((await t.environmentManifest(ref.name, ref.version)) ??
          fail(
            404,
            ref.version === undefined
              ? `No environment manifest is named ${ref.name}: save it first (PUT /v1/environment-manifests/${ref.name}).`
              : `Environment manifest ${ref.name} has no version ${ref.version}.`,
            { code: "manifest_not_found" },
          ));
    const kind = manifest ? (manifest.body.kind ?? "virtual") : (body.kind ?? "virtual");
    if (manifest && kind === "pod") await requirePods(ctx.pods, `Environment manifest ${manifest.name} is of kind pod, and a pod Environment`);
    const recipe = resolve(kind, manifest ? manifestRecipeRequest(manifest.body) : recipeRequest(body), true);
    await checkFiles(t, recipe.files);
    const from = body.from === undefined ? undefined : await forkSource(t, scope, kind, body.from);
    // A fork onto other setup runs it on the written disk (Q17).
    const seed = from && fork?.setup ? { ...from, setup: true as const } : from;
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
      ...(manifest ? { manifestName: manifest.name, manifestVersion: manifest.version } : {}),
      manifestHash: recipeHash(recipe),
      ...(fork ? { forkedFrom: { environment: fork.source, disk: seed?.version ?? null } } : {}),
      ...(seed
        ? {
            diskSeed: seed,
            diskOp: {
              kind: "seed" as const,
              version: seed.version,
              startedAt: now,
              until: new Date(Date.now() + SEED_LEASE_MS).toISOString(),
            },
          }
        : {}),
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
    const vaultId = await ctx.vault.createEnvironmentVault(t, id, actorOf(scope), fork?.sealed?.vaultId);
    if (fork?.sealed)
      fork.copied = await ctx.vault.insertEnvironmentSecretCopies(t, vaultId, fork.source, actorOf(scope), fork.sealed.copies);
    const madeFrom = manifest ? { manifest: { name: manifest.name, version: manifest.version } } : {};
    await t.environmentEvent(id, "environment.created", {
      kind,
      labels: row.labels,
      ...madeFrom,
      ...(seed ? { from: { environment: body.from!.environment, version: seed.version } } : {}),
      ...(row.forkedFrom ? { forkedFrom: row.forkedFrom } : {}),
    });
    if (fork)
      await t.environmentEvent(fork.source, "environment.forked", {
        to: id,
        disk: seed?.version ?? null,
        ...madeFrom,
        secrets: fork.copied?.copied.length ?? 0,
      });
    if (row.pod) {
      // Created at once; idle from now if no turn comes.
      await reconcileAfter(t, id);
      const idleAt = Date.parse(now) + podLifecycleConfig(await readSandboxConfig(t), recipe).idleMs;
      await t.signalSandbox(id, { kind: "arm", timer: "idle", at: idleAt });
    }
    return viewOf(ctx, t, row, subjectOf(scope));
  });
  // A virtual fork's workspace is written at once (a pod's once its engine connects).
  if (body.from !== undefined && view.kind === "virtual") {
    await runPendingSeed(ctx, id);
    return getEnvironment(ctx, id, scope);
  }
  return view;
}

/**
 * The secret write `raw` asks of Environment `id` (D64). When what it runs declares secret
 * slots, the name must be one (`409 secret_not_in_manifest`), and the body is `{ value }` (or
 * `{ headers }` for a `headers` slot) with the binding from the slot; a full typed body is
 * accepted only when its binding is the slot's. Without slots, today's typed body.
 */
export async function secretRequestFor(
  ctx: TenantContext,
  id: string,
  name: string,
  raw: unknown,
): Promise<PutEnvironmentSecretRequest> {
  const environment = await ctx.store.tx((t) => liveEnvironment(t, id));
  const slots = environment?.recipe.secrets;
  if (!environment || slots === undefined) return PutEnvironmentSecretRequestSchema.parse(raw);
  const slot =
    slots[name] ??
    fail(
      409,
      `What Environment ${id} runs declares no secret ${name}${environment.manifestName ? ` (manifest ${environment.manifestName}@${environment.manifestVersion})` : ""}: add the slot to the manifest, then make or fork an Environment from the new version.`,
      { code: "secret_not_in_manifest", details: { declared: Object.keys(slots).sort() } },
    );
  const full = slotRequest(slot);
  if (raw !== null && typeof raw === "object" && "type" in raw) {
    const body = PutEnvironmentSecretRequestSchema.parse(raw);
    const { requestId: _, value: _v, headers: _h, ...binding } = body as PutEnvironmentSecretRequest & {
      value?: string;
      headers?: unknown;
    };
    if (canonical(binding) !== canonical(full))
      fail(409, `Secret ${name}'s type and binding come from what Environment ${id} runs: send only its value ({ "value": "…" }).`, {
        code: "secret_not_in_manifest",
      });
    return body;
  }
  const { requestId, value, headers } = PutEnvironmentSecretValueRequestSchema.parse(raw);
  const withId = requestId === undefined ? {} : { requestId };
  if (slot.type === "headers") {
    if (headers === undefined) fail(400, `Secret ${name} is a headers credential: send { "headers": { … } }.`);
    return PutEnvironmentSecretRequestSchema.parse({ ...withId, ...full, headers });
  }
  if (value === undefined) fail(400, `Secret ${name} takes a value: send { "value": "…" }.`);
  return PutEnvironmentSecretRequestSchema.parse({ ...withId, ...full, value });
}

/** A slot's type and binding, as a secret write's fields (without the value). */
function slotRequest(slot: EnvironmentSecretSlot): Record<string, unknown> {
  const { required: _r, description: _d, ...binding } = slot;
  return binding;
}

/**
 * The disk version a create's `from` names (R2d step 3): the caller's grants must reach the
 * source, a caller acting for a person must be its guard's owner, and kind `none` has no disk.
 */
async function forkSource(
  t: Tx,
  scope: AuthScope,
  kind: EnvironmentKind,
  from: NonNullable<PutEnvironmentRequest["from"]>,
): Promise<{ artifactId: string; version: number }> {
  if (kind === "none") fail(400, "from is for an Environment with a disk: kind none has none.");
  reachable(environmentGrantsOf(scope), from.environment);
  const source = (await liveEnvironment(t, from.environment)) ?? notFound();
  const subject = subjectOf(scope);
  if (subject !== undefined && source.ownerUserId !== undefined && source.ownerUserId !== subject) notFound();
  return forkSeedOf(t, from);
}

/** What a create does for a fork (`POST .../fork`); `copied` is filled in by the create. */
interface Fork {
  source: string;
  setup: boolean;
  /**
   * The source's secrets sealed by keys for the new vault `vaultId` (F4.2), before the create's
   * transaction, which inserts them; absent with `secrets: none`.
   */
  sealed?: { vaultId: string; copies: SealedSecretCopies };
  copied?: { copied: string[]; dropped: string[] };
}

/**
 * `POST /v1/environments/{id}/fork` (Q15): how an Environment gets a new manifest version. A new
 * Environment `body.id` is made from the manifest version (default the source's manifest at its
 * latest), its disk started from a version of the source's (`latest` takes a snapshot first,
 * refused during a turn), and its secrets copied inside the Runtime. A fork onto other setup
 * runs that setup on the copied disk before its first turn (Q17). The source keeps what it runs,
 * its disk and its sessions. With `dryRun`, the plan only.
 */
export async function forkEnvironment(
  ctx: TenantContext,
  sourceId: string,
  body: ForkEnvironmentRequest,
  scope: AuthScope,
): Promise<ForkEnvironmentResponse> {
  const grants = environmentGrantsOf(scope);
  reachable(grants, sourceId);
  reachable(grants, body.id);
  if (body.id === sourceId) fail(400, "A fork is a new Environment: give it another id.");
  const { plan: planned, slots } = await ctx.store.tx(async (t) => {
    const source = (await liveEnvironment(t, sourceId)) ?? notFound();
    const subject = subjectOf(scope);
    if (subject !== undefined && source.ownerUserId !== undefined && source.ownerUserId !== subject) notFound();
    const ref = body.manifest === undefined ? undefined : parseEnvironmentManifestRef(body.manifest);
    if (body.manifest !== undefined && ref === undefined)
      fail(400, "manifest is an environment manifest's name, or name@version such as analyst-box@3.");
    const name =
      ref?.name ??
      source.manifestName ??
      fail(
        400,
        `Environment ${sourceId} was made from inline fields, not a manifest: name the manifest to fork it onto (manifest).`,
      );
    const manifest =
      (await t.environmentManifest(name, ref?.version)) ??
      fail(
        404,
        ref?.version === undefined
          ? `No environment manifest is named ${name}.`
          : `Environment manifest ${name} has no version ${ref.version}.`,
        { code: "manifest_not_found" },
      );
    const kind = manifest.body.kind ?? "virtual";
    const resolved = resolveRecipe(kind, manifestRecipeRequest(manifest.body), effectiveSandboxConfig(await readSandboxConfig(t)));
    const errors = [
      ...(resolved.kind === "error" ? resolved.errors : []),
      ...limitIssues(manifest.body.limits, await readTenantLimits(t)),
      ...manifestShapeIssues(manifest.body, await readRuntimeLimits(t)),
      ...labelIssues(body.labels, await readRuntimeLimits(t)),
    ];
    if (resolved.kind === "error" || errors.length > 0) return fail(400, errors.join(" "));
    const recipe = resolved.recipe;
    const asked = body.disk ?? "latest";
    const disk =
      kind === "none" || source.kind === "none" || asked === "empty"
        ? null
        : asked === "latest"
          ? ("latest" as const)
          : (await forkSeedOf(t, { environment: sourceId, version: asked })).version;
    const vault = await t.vaultOfEnvironment(sourceId);
    const names = vault
      ? (await t.credentialsForVault(vault.id)).filter((row) => row.type !== "model").map((row) => row.name).sort()
      : [];
    const copied = body.secrets === "none" ? [] : names.filter((item) => recipe.secrets === undefined || item in recipe.secrets);
    const plan: EnvironmentForkPlan = {
      source: sourceId,
      id: body.id,
      kind,
      manifest: { name: manifest.name, version: manifest.version },
      disk,
      setup:
        kind === "pod" &&
        disk !== null &&
        recipeHash(recipe) !== source.manifestHash &&
        Boolean(recipe.setup?.length || recipe.files?.length),
      secrets: {
        copied,
        dropped: names.filter((item) => !copied.includes(item)),
        missing: (Object.entries(recipe.secrets ?? {}) as [string, EnvironmentSecretSlot][])
          .filter(([item, slot]) => slot.required === true && !copied.includes(item))
          .map(([item]) => item)
          .sort(),
      },
      changes: manifestChanges(source.recipe, recipe),
      sessions: (await t.sessionsOnEnvironment(sourceId)).length,
    };
    const slots =
      recipe.secrets === undefined
        ? null
        : Object.fromEntries(Object.entries(recipe.secrets).map(([item, slot]) => [item, slotRequest(slot)]));
    return { plan, slots };
  });
  if (body.dryRun) return { dryRun: true, plan: planned };
  // `latest`: a version of the disk as it is now, between turns (an unchanged disk makes none).
  const disk = planned.disk === "latest" ? (await snapshotEnvironment(ctx, sourceId, scope)).version : planned.disk;
  // Keys holds the vault key (F4.2): it seals the copies first, outside the create's transaction,
  // and the create inserts them, so the fork is still one commit.
  const vaultId = randomUUID();
  const sealed =
    (body.secrets ?? "copy") === "copy"
      ? { vaultId, copies: await ctx.keys.sealEnvironmentSecretCopies(sourceId, vaultId, slots) }
      : undefined;
  const fork: Fork = { source: sourceId, setup: planned.setup, ...(sealed ? { sealed } : {}) };
  const environment = await putEnvironment(
    ctx,
    body.id,
    {
      ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
      manifest: `${planned.manifest!.name}@${planned.manifest!.version}`,
      ...(body.labels === undefined ? {} : { labels: body.labels }),
      ...(body.ownerUserId === undefined ? {} : { ownerUserId: body.ownerUserId }),
      ...(disk === null ? {} : { from: { environment: sourceId, version: disk } }),
    },
    scope,
    { fork },
  );
  const copied = fork.copied ?? { copied: [], dropped: planned.secrets.copied };
  const dropped = [...new Set([...planned.secrets.dropped, ...copied.dropped])].sort();
  return {
    environment,
    plan: {
      ...planned,
      disk,
      secrets: {
        copied: copied.copied,
        dropped,
        missing: Object.entries(environment.manifest.secrets ?? {})
          .filter(([item, slot]) => slot.required === true && !copied.copied.includes(item))
          .map(([item]) => item)
          .sort(),
      },
    },
  };
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

/**
 * Asks pod Environment `id` to run when it is stopped or failed (a disk copy needs its engine),
 * with its recipe applied, as a turn start would.
 */
export async function wakePod(ctx: TenantContext, id: string): Promise<void> {
  if (!ctx.pods) fail(409, `Environment ${id} is a pod Environment, and this Runtime has no sandbox pods.`, { code: "environment_unavailable" });
  await ctx.store.tx(async (t) => {
    const environment = await liveEnvironment(t, id, { lock: true });
    const pod = environment?.pod;
    if (!environment || !pod) return;
    if (pod.observed === "lost")
      fail(409, `Environment ${id} was lost (${pod.reason ?? "its volume is gone"}). Reset or restore it.`, {
        code: "environment_lost",
      });
    const now = new Date().toISOString();
    if (pod.desired !== "running" || pod.observed === "failed") {
      await wantRunning(t, environment as PodEnvironment, now);
      await reconcileAfter(t, id);
    } else await t.updateEnvironmentPod(id, { lastActiveAt: now }, now);
  });
}

/** Whether a disk lease (R2d step 3) holds `environment` now. */
export function diskHeld(environment: Environment, now = Date.now()): boolean {
  return environment.diskOp !== undefined && Date.parse(environment.diskOp.until) > now;
}

/** Refused while a snapshot or restore copies the disk (a pending seed does not count). */
export function refuseDiskCopy(environment: Environment): void {
  if (diskHeld(environment) && environment.diskOp!.kind !== "seed")
    fail(409, `Environment ${environment.id}'s disk is being copied (${environment.diskOp!.kind}). Try again shortly.`, {
      code: "environment_busy",
      details: { retryAfterSeconds: 5 },
    }, { "retry-after": "5" });
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
): Promise<string[]> {
  const id = environment.id;
  await t.environmentEvent(id, "environment.deleted", { reason });
  await ctx.vault.deleteEnvironmentVault(t, id, actor);
  // Its disk versions go with it; their manifests' bytes are the caller's, after the commit.
  const keys = await deleteDiskArtifact(ctx, t, id);
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
  return keys;
}

/** Deletes the Object store keys a deletion returned, after its commit. */
async function deleteKeys(ctx: TenantContext, keys: readonly string[]): Promise<void> {
  for (const key of keys) await ctx.blobs.delete(key).catch(() => undefined);
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
    if (!environment) return undefined;
    await refuseBusy(t, id);
    refuseDiskCopy(environment);
    return deleteIn(ctx, t, environment, actorOf(scope), "delete");
  });
  // After the commit: a turn that starts now finds no Environment and is refused.
  if (deleted) {
    await deleteKeys(ctx, deleted);
    await ctx.sandbox.removeSandbox(id);
  }
  return { id, deleted: deleted !== undefined };
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
        if (!environment || ms === undefined || Date.parse(environment.lastUsedAt) + ms > now) return undefined;
        const busy = (await t.sessionsOnEnvironment<Session>(environment.id)).some(
          (session) => session.activeTurnId !== null,
        );
        if (busy || diskHeld(environment)) return undefined;
        return deleteIn(ctx, t, environment, "sweep", "deleteAfter");
      });
      if (deleted) {
        await deleteKeys(ctx, deleted);
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
    refuseDiskCopy(environment);
    const pod = environment.pod;
    if (pod.retiring !== undefined)
      fail(409, `Environment ${id} is still deleting its previous volume. Try again shortly.`, {
        code: "environment_busy",
        details: { retryAfterSeconds: 5 },
      }, { "retry-after": "5" });
    await newVolume(ctx, t, environment);
    return viewOf(ctx, t, (await t.environment(id)) ?? environment, subjectOf(scope));
  });
}

/**
 * Gives pod Environment `environment` (locked) a new pod on a new, empty volume, the next volume
 * generation, with its recipe applied: the old Sandbox and volume are retired. With `seed`, the
 * new volume starts from that disk version before any turn (R2d step 3): a restore, or the
 * recovery of a lost volume.
 */
export async function newVolume(
  ctx: TenantContext,
  t: Tx,
  environment: Environment,
  options: {
    seed?: { artifactId: string; version: number };
    reason?: "restore" | "lost";
  } = {},
): Promise<number> {
  const id = environment.id;
  const pod = environment.pod!;
  const now = new Date().toISOString();
  const volumeGen = pod.volumeGen + 1;
  const epoch = pod.hostEpoch + 1;
  await t.updateEnvironment(
    id,
    {
      applied: environment.recipe,
      appliedVersion: environment.version,
      lastUsedAt: now,
      ...(!options.seed
        ? { diskSeed: null, diskOp: null }
        : {
            diskSeed: options.seed,
            diskOp: {
              kind: "seed",
              version: options.seed.version,
              startedAt: now,
              until: new Date(Date.now() + SEED_LEASE_MS).toISOString(),
            },
          }),
    },
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
  await t.environmentEvent(id, "environment.reset", {
    volumeGeneration: volumeGen,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.seed ? { from: { version: options.seed.version } } : {}),
  });
  await reconcileAfter(t, id);
  await revokeHost(t, id, epoch);
  return volumeGen;
}

/** How long a pending seed holds the disk before another process may take it over. */
export const SEED_LEASE_MS = 10 * 60_000;

/** `GET /v1/environments/{id}/events`: the Environment's lifecycle stream. */
export async function environmentEventsOf(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
  query: EnvironmentEventsQuery = {},
) {
  reachable(environmentGrantsOf(scope), id);
  return ctx.store.tx(async (t) => ({ events: await t.environmentEvents(id, query) }));
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
 * its owner guard admits the session's owner, and no disk copy holds it. Other sessions' turns
 * do not stop it (D66). Holds the Environment row's lock until the transaction ends, so a turn
 * start and disk work on one Environment are decided one after the other.
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
  // session never moves to another harness: its state is that harness's. An Environment's
  // harness never changes since protocol 14, so this refuses a session whose Environment id was
  // deleted and made again with another harness, and an Environment changed in place before
  // protocol 14 whose recipe (a pod's, at its wake) names another harness than it applied.
  const waking = environment.pod !== undefined && (environment.pod.desired !== "running" || environment.pod.observed === "failed");
  const runs = waking ? environment.recipe.harness : environment.applied.harness;
  if (!isWorkflowManifest(session.manifest) && runs !== harnessOf(session))
    fail(409, `Environment ${id} runs the ${runs} harness, and this session runs ${harnessOf(session)}: open a new session to run on it.`, {
      code: "harness_mismatch",
      details: { harness: harnessOf(session), environmentHarness: runs },
    });
  if (environment.kind === "none") return;
  // A snapshot or restore copies the disk between turns (R2d step 3); a seed's turn waits.
  refuseDiskCopy(environment);
  const pod = environment.pod;
  if (!pod) return;
  if (!ctx?.pods)
    fail(409, `Environment ${id} is a pod Environment, and this Runtime has no sandbox pods: run \`nylorun local sandbox enable --context <name>\`.`, {
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
