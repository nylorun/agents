/**
 * Agents (protocol 16; Environments from protocol 11, D55, D56): `PUT`, `GET` and `DELETE
 * /v1/agents/{id}`, the list, stop, reset, fork and the lifecycle stream; sessions on one, and the
 * checks every turn start makes on it.
 *
 * - **The instance of a manifest.** An Agent is made from one version of a saved agent manifest
 *   (`manifest: "name"`, tracking, or `"name@n"`, pinned; `agent-manifests.ts`) and runs one
 *   version of it at a time (`resolvedVersion`). A `PUT` on an existing id may change its labels
 *   and owner guard, and moves it to the version its `manifest` names (track T3,
 *   `agent-versions.ts`; `?dryRun=true` answers the plan); a save moves every Agent that tracks
 *   the manifest. Its manifest's name, kind, harness and storage are fixed for its life: a fork
 *   makes a new Agent to change them. Its kind is its manifest's `runtime.kind` (`none` without a
 *   runtime section).
 * - **No scope, no main session** (D70, D71). The Runtime decides nothing about who uses an
 *   Agent or which sessions it has: the app opens sessions on it with ids it picks, and deleting
 *   a session (a sessions reset) only detaches it.
 * - **Its environment: one sandbox, one vault.** Kind `virtual` (a just-bash workspace in the
 *   harness container, keyed by the Agent id and created on the first tool call), `pod` (an
 *   agent-sandbox pod on the Tenant's cluster, Host feature `sandbox-pods`, created at once) or
 *   `none` (no compute). Each has one vault (`vault/service.ts`), created and deleted with it in
 *   one transaction. The store calls this part the Agent's environment (`Environment`, keyed by
 *   the Agent's id).
 * - **State on read.** `state` is derived when it is read, the first rule that holds: `paused`
 *   (desired `off`, track T6), `failing` (its compute failed or was lost, or a session's last
 *   turn failed), `input_required` (a session waits on a person, or a required secret is unset),
 *   `working` (a turn runs),
 *   `sleeping`; `attention` names the sessions behind each that holds (`stateOf`).
 * - **Secret slots** (D64): when its manifest declares `secrets`, a secret write sends only the
 *   value, the binding comes from the slot, and a name it does not declare is
 *   `409 secret_not_in_manifest` (`secretRequestFor`).
 * - **Access.** An application key reaches every Agent, and so does an application key acting
 *   for a subject (`Nylorun-Subject`), which needs `agents:write` to change one. A token caller
 *   reaches only the ids its Agent grants match, and changes them only with `agents:write`; any
 *   other id is the 404 of a missing one.
 * - **The owner guard.** When `owner` is set, only that owner's sessions may run on the Agent,
 *   checked when a session opens and at every turn start (`403 agent_owner_mismatch`; the opaque
 *   404 to a caller acting for a person).
 * - **Parallel turns (D66).** Sessions on one Agent run their turns at the same time and share
 *   its `/workspace`; one turn per session stays. Disk work (snapshot, restore, stop, reset)
 *   waits until no turn runs (`409 agent_busy`), and a turn waits while a seed copies a disk.
 * - **Lifecycle.** `POST .../stop` suspends a pod (the volume is kept; the next turn starts it),
 *   `POST .../reset` gives it a new pod on a new volume. A lost pod refuses turns (`agent_lost`)
 *   until a reset. `lifecycle.deleteAfter` deletes an Agent unused for that long (the Tenant
 *   sweep, `sweepUnusedAgents`). Deleting a pod Agent keeps its row (`desired: deleted`, invisible
 *   here) until its Sandbox is gone; its vault goes at once.
 * - **Lifecycle events** go to the Agent's own stream in the record (`Tx.agentEvent`,
 *   `record/agent.ts`); the session's log records `agent.attached` too.
 */
import { randomUUID } from "node:crypto";
import {
  agentGranted,
  parseAgentManifestRef,
  PutAgentSecretRequestSchema,
  PutAgentSecretValueRequestSchema,
  type AgentAttention,
  type AgentForkPlan,
  type AgentMovePlan,
  type AgentState,
  type EnvironmentKind,
  type EnvironmentRecipe,
  type EnvironmentSecretSlot,
  type AgentView,
  type ForkAgentRequest,
  type ForkAgentResponse,
  type PutAgentRequest,
  type PutAgentSecretRequest,
} from "@nylorun/core/contracts";
import { isWorkflowManifest, parseSandboxDuration, runtimeOf } from "@nylorun/core/define";
import { canonical } from "../store/canonical.js";
import type { Environment, AgentEventsQuery, SandboxPodState, Tx } from "../store/types.js";
import { resolveRecipe, type RecipeRequest } from "../sandbox/resolve.js";
import { sandboxWorkspaceKey } from "../sandbox/records.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import { podName } from "../sandbox/pods/name.js";
import { podLifecycleConfig } from "../sandbox/pods/spec.js";
import { SETUP_FAILED } from "../sandbox/pods/lifecycle.js";
import { requirePods } from "../sandbox/placement.js";
import type { SandboxRouteDeps } from "../core/sandbox-routes.js";
import { deleteDiskArtifact, forkSeedOf, runPendingSeed, snapshotEnvironment } from "../artifacts/disk.js";
import { manifestChanges, manifestRecipeRequest } from "./agent-manifests.js";
import { idleMsOf, moveAgent, planMove, resumeMove, switchTo, waitingFor, type Move } from "./agent-versions.js";
import { slotHolds } from "../vault/service.js";
import {
  labelIssues,
  limitIssues,
  limitsInForce,
  manifestShapeIssues,
  readTenantLimits,
  secretRequestIssues,
} from "./limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { armAgentTriggers, createAgentTriggers } from "./triggers.js";
import { harnessOf, sessionOf, type AuthScope, type Session, type TenantContext } from "./context.js";
import { fail, failRetryLater } from "./http.js";
import type { SealedSecretCopies } from "../vault/service.js";
import { hostTuning } from "../tuning.js";

/** The Agent grants that limit `scope`, or undefined when it reaches every Agent. */
export function agentGrantsOf(scope: AuthScope): readonly string[] | undefined {
  return scope.kind === "token" && scope.agents !== "*" ? [...scope.agents] : undefined;
}

/** The subject a request acts for, when it acts for one. */
function subjectOf(scope: AuthScope): string | undefined {
  return scope.kind === "token" || scope.kind === "subject" ? scope.subject : undefined;
}

/** Who the vault's audit rows name for a request: the subject, else the application. */
export function actorOf(scope: AuthScope): string {
  return subjectOf(scope) ?? "application";
}

const notFound = (): never => fail(404, "Agent not found");

/** The Agent, when `grants` reach it; otherwise the 404 of a missing one. */
function reachable(grants: readonly string[] | undefined, id: string): void {
  if (grants !== undefined && !agentGranted(grants, id)) notFound();
}

/** Refuses (the 404 of a missing one) Agent `id` when the caller's grants miss it. */
export function assertReaches(scope: AuthScope, id: string): void {
  reachable(agentGrantsOf(scope), id);
}

/** A pod Agent being deleted is no longer an Agent, here. */
function live(row: Environment | undefined): Environment | undefined {
  return row?.pod?.desired === "deleted" ? undefined : row;
}

/** An Agent's row, unless it is gone or being deleted. */
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

/** The order the states rank in: the first that holds is the Agent's. */
const STATE_RANK: readonly AgentState[] = ["paused", "failing", "input_required", "working", "sleeping"];

/**
 * An Agent's state (protocol 16), from its desired state, its compute and its sessions, and
 * every state that holds with the session behind it (`attention`), highest first. A session waits
 * on a person while it is paused (an approval or an interaction) or uncertain, and the Agent while
 * a move waits for its required secrets (track T3), or a required secret of the version it runs
 * has no value (`unsetSecrets`, track T7: a tool would fail when it is called); a session's last
 * turn failed while it is `failed`; a turn runs while it is `running`, `runnable` or `waiting`.
 */
export function stateOf(
  agent: Pick<Environment, "desiredState" | "pod"> &
    Partial<Pick<Environment, "targetVersion" | "appliedVersion" | "version" | "failedVersion">>,
  sessions: readonly Pick<Session, "id" | "status">[],
  unsetSecrets: readonly string[] = [],
): { state: AgentState; attention: AgentAttention[] } {
  const attention: AgentAttention[] = [];
  if (agent.desiredState === "off") attention.push({ state: "paused", reason: "desired off" });
  // A move that waits for a person to set its required secrets (track T3).
  if (agent.targetVersion !== undefined && agent.appliedVersion === agent.version)
    attention.push({ state: "input_required", reason: `secret_required: version ${agent.targetVersion} waits for its required secrets` });
  // A required secret of the version it runs, unset (track T7).
  for (const name of unsetSecrets)
    attention.push({ state: "input_required", reason: `secret_unset: required secret ${name} unset` });
  const pod = agent.pod;
  if (pod && (pod.observed === "failed" || pod.observed === "lost") && pod.desired !== "deleted")
    attention.push({ state: "failing", reason: `compute ${pod.observed}${pod.reason ? `: ${pod.reason}` : ""}` });
  // A start on a new version failed and went back (track T3): until a start on a new one succeeds.
  if (agent.failedVersion !== undefined)
    attention.push({ state: "failing", reason: `start_failed: version ${agent.failedVersion} did not start` });
  for (const session of sessions) {
    const status = String(session.status);
    const state: AgentState | undefined =
      status === "failed"
        ? "failing"
        : status === "paused" || status === "uncertain"
          ? "input_required"
          : status === "running" || status === "runnable" || status === "waiting"
            ? "working"
            : undefined;
    if (state) attention.push({ state, sessionId: session.id, reason: status });
  }
  attention.sort((a, b) => STATE_RANK.indexOf(a.state) - STATE_RANK.indexOf(b.state));
  return { state: attention[0]?.state ?? "sleeping", attention };
}

/** How an Agent names its manifest: `name` when it tracks it, `name@n` when pinned. */
export function manifestRefOf(agent: Pick<Environment, "manifestName" | "manifestVersion" | "manifestRef">): string {
  return agent.manifestRef === "tracking" ? agent.manifestName : `${agent.manifestName}@${agent.manifestVersion}`;
}

async function viewOf(
  ctx: TenantContext,
  t: Tx,
  environment: Environment,
  owner: string | undefined,
): Promise<AgentView> {
  const sessions = await t.sessionsOnEnvironment<Session>(environment.id);
  const record =
    environment.kind === "virtual"
      ? await t.get<{ state?: string }>(
          "sandboxes",
          sandboxWorkspaceKey(ctx.config.tenantId, environment.id),
        )
      : undefined;
  const pod = environment.pod;
  const visible = sessions.filter((session) => owner === undefined || session.ownerUserId === owner);
  const { state, attention } = stateOf(environment, visible, await unsetRequiredSecrets(t, environment));
  return {
    id: environment.id,
    manifest: manifestRefOf(environment),
    resolvedVersion: environment.manifestVersion,
    manifestHash: environment.manifestHash,
    tracking: environment.manifestRef,
    targetVersion: environment.targetVersion ?? null,
    waitingFor: waitingFor(environment),
    failedVersion: environment.failedVersion ?? null,
    startCheck: environment.startCheck
      ? { from: environment.startCheck.from.manifestVersion, startedAt: environment.startCheck.startedAt }
      : null,
    kind: environment.kind,
    harness: environment.applied.harness,
    owner: environment.ownerUserId ?? null,
    labels: environment.labels,
    state,
    attention,
    desired: environment.desiredState,
    nextWakeAt: await t.nextWakeAt(environment.id),
    compute: {
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
    },
    runtime: environment.applied,
    limits: limitsInForce(await readTenantLimits(t), environment.applied.limits),
    sessions: visible.map((session) => ({
      id: session.id,
      ownerUserId: session.ownerUserId,
      status: String(session.status),
      activeTurnId: session.activeTurnId,
    })),
    slots: (await slotsOf(t, environment)) ?? [],
    ...(environment.kind === "none"
      ? {}
      : {
          disk: {
            latestVersion: (await t.diskArtifact(environment.id))?.latestVersion || null,
            operation: diskHeld(environment)
              ? {
                  kind: environment.diskOp!.kind,
                  ...(environment.diskOp!.version === undefined ? {} : { version: environment.diskOp!.version }),
                  startedAt: environment.diskOp!.startedAt,
                }
              : null,
          },
        }),
    forkedFrom: environment.forkedFrom ?? null,
    lastUsedAt: environment.lastUsedAt,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

/**
 * The secret slots a secret write fills (D64): the version `environment` moves to while it is
 * outdated (track T3), so its new slots can be set before it applies, else the one it runs.
 */
async function slotsAhead(t: Tx, environment: Environment): Promise<EnvironmentRecipe["secrets"]> {
  if (environment.targetVersion === undefined) return environment.applied.secrets;
  // Waiting for its pod's start, `recipe` is the target's runtime.
  if (environment.appliedVersion !== environment.version) return environment.recipe.secrets;
  const target = await t.agentManifest(environment.manifestName, environment.targetVersion);
  return target ? runtimeOf(target.body).secrets : environment.applied.secrets;
}

/**
 * The required secret slots of the version `environment` runs (its applied runtime) that its vault
 * holds no value for, by name: the Agent's attention (track T7), before a tool fails for want of
 * one. A move waiting on the next version's secrets is its own attention item (`stateOf`).
 */
async function unsetRequiredSecrets(t: Tx, environment: Environment): Promise<string[]> {
  const required = Object.entries(environment.applied.secrets ?? {}).filter(([, slot]) => slot.required === true);
  if (required.length === 0) return [];
  const vault = await t.vaultOfEnvironment(environment.id);
  const rows = vault ? await t.credentialsForVault(vault.id) : [];
  return required
    .filter(([name, slot]) => !rows.some((row) => row.name === name && slotHolds(slot, row)))
    .map(([name]) => name)
    .sort();
}

/** Each secret slot `environment` declares (`slotsAhead`), and whether its vault holds a value that fills it. */
async function slotsOf(t: Tx, environment: Environment): Promise<AgentView["slots"] | undefined> {
  const declared = await slotsAhead(t, environment);
  if (declared === undefined) return undefined;
  const vault = await t.vaultOfEnvironment(environment.id);
  const rows = vault ? await t.credentialsForVault(vault.id) : [];
  return Object.entries(declared)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, slot]) => ({
      name,
      type: slot.type,
      required: slot.required ?? false,
      set: rows.some((row) => row.name === name && slotHolds(slot, row)),
    }));
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
    fail(403, "A request acting for a person may set owner only to that person.");
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
  // A move whose runtime waits for this start switches now (track T3).
  if (!(await switchTo(t, environment, now)) && environment.appliedVersion !== environment.version)
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
 * `PUT /v1/agents/{id}`: creates the Agent and its vault (within the Tenant's limit on their
 * number) from a saved agent manifest's version, or finds the one with this id, so "get or
 * create" is one call. On an existing one, its labels and owner guard may change, and `manifest`
 * moves it to the version it names (track T3, `moveAgent`): `name` tracks the latest (unless that
 * failed to start), `name@n` pins `n`. Another manifest name is `409 agent_fixed_field`. Every
 * `PUT` counts as the Agent's use.
 */
export async function putAgent(
  ctx: TenantContext,
  id: string,
  body: PutAgentRequest,
  scope: AuthScope,
  options: { fork?: Fork } = {},
): Promise<AgentView> {
  const fork = options.fork;
  reachable(agentGrantsOf(scope), id);
  const ref =
    parseAgentManifestRef(body.manifest) ??
    fail(400, "manifest is an agent manifest's name, or name@version such as triage@3.");
  const view = await ctx.store.tx(async (t) => {
    const now = new Date().toISOString();
    const config = effectiveSandboxConfig(await readSandboxConfig(t));
    const tenantLimits = await readTenantLimits(t);
    const runtimeLimits = await readRuntimeLimits(t);
    // Labels are checked whenever they are set; what it runs only when it is made, so a
    // get-or-create on one made before the Tenant lowered a limit still answers.
    const labels = labelIssues(body.labels, runtimeLimits);
    if (labels.length > 0) fail(400, labels.join(" "));
    const deleting = (row: Environment | undefined) => {
      if (row && !live(row))
        failRetryLater(`Agent ${id} is being deleted. Try again once it is gone.`, "agent_busy");
    };
    const found = async (existing: Environment): Promise<AgentView> => {
      if (fork !== undefined) fail(409, `Agent ${id} exists: a fork makes a new Agent, so name another id.`);
      if (body.from !== undefined) fail(409, `Agent ${id} exists: from applies only when a PUT creates one.`);
      checkGuard(scope, body.owner, existing.ownerUserId);
      const move = await moveOf(t, existing, ref);
      // A tracking Agent named as it is made (get-or-create) stays where it can move to.
      const stays = move.plan.applies === "refused" && ref.version === undefined && existing.manifestRef === "tracking";
      if (!stays) await moveAgent(t, existing, move, now);
      const patch: Parameters<Tx["updateEnvironment"]>[1] = { lastUsedAt: now };
      if (body.labels !== undefined && canonical(body.labels) !== canonical(existing.labels)) patch.labels = body.labels;
      if (body.owner !== undefined && (body.owner ?? undefined) !== existing.ownerUserId) patch.ownerUserId = body.owner;
      await t.updateEnvironment(id, patch, now);
      return viewOf(ctx, t, (await t.environment(id)) ?? existing, subjectOf(scope));
    };
    const existing = await t.environment(id, { lock: true });
    deleting(existing);
    if (existing) return found(existing);
    checkGuard(scope, body.owner);
    const version = fork?.version ?? ref.version;
    const manifest =
      (await t.agentManifest(ref.name, version)) ??
      fail(
        404,
        version === undefined
          ? `No agent manifest is named ${ref.name}: save it first (PUT /v1/agent-manifests/${ref.name}).`
          : `Agent manifest ${ref.name} has no version ${version}.`,
        { code: "manifest_not_found" },
      );
    const runtime = runtimeOf(manifest.body);
    const kind = runtime.kind;
    if (kind === "pod") await requirePods(ctx.pods, `Agent manifest ${manifest.name} is of kind pod, and a pod Agent`);
    const resolved = resolveRecipe(kind, manifestRecipeRequest(manifest.body), config);
    const errors = [
      ...(resolved.kind === "error" ? resolved.errors : []),
      ...limitIssues(runtime.limits, tenantLimits),
      ...manifestShapeIssues(runtime, runtimeLimits),
    ];
    if (resolved.kind === "error" || errors.length > 0) return fail(400, errors.join(" "));
    const recipe = resolved.recipe;
    await checkFiles(t, recipe.files);
    const from = body.from === undefined ? undefined : await forkSource(t, scope, kind, body.from);
    // A fork onto other setup runs it on the written disk (Q17).
    const seed = from && fork?.setup ? { ...from, setup: true as const } : from;
    const tracking = ref.version === undefined ? ("tracking" as const) : ("pinned" as const);
    const row: Environment = {
      id,
      kind,
      labels: body.labels ?? {},
      recipe,
      applied: recipe,
      version: 1,
      appliedVersion: 1,
      ...(body.owner ? { ownerUserId: body.owner } : {}),
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
      manifestName: manifest.name,
      manifestVersion: manifest.version,
      manifestRef: tracking,
      manifestHash: manifest.hash,
      desiredState: "on",
      ...(fork ? { forkedFrom: { agent: fork.source, disk: seed?.version ?? null } } : {}),
      ...(seed
        ? {
            diskSeed: seed,
            diskOp: {
              kind: "seed" as const,
              version: seed.version,
              startedAt: now,
              until: new Date(Date.now() + hostTuning().tenant.seedLeaseMs).toISOString(),
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
      fail(409, `This Tenant allows at most ${config.limits.environments} Agents.`, {
        code: "limit_exceeded",
        details: { limit: "environments", max: config.limits.environments },
      });
    if (created === "exists") {
      // Created by another request since the read above: answer as for an existing one.
      const again = (await t.environment(id, { lock: true })) ?? notFound();
      deleting(again);
      return found(again);
    }
    // Its triggers start active (D74); armed after the commit.
    await createAgentTriggers(t, row);
    // A fork starts with the source's memories as they are now, with no history (T5).
    if (fork) await t.copyMemories(fork.source, id, now);
    const vaultId = await ctx.vault.createEnvironmentVault(t, id, actorOf(scope), fork?.sealed?.vaultId);
    if (fork?.sealed)
      fork.copied = await ctx.vault.insertEnvironmentSecretCopies(t, vaultId, fork.source, actorOf(scope), fork.sealed.copies);
    await t.agentEvent(id, "agent.created", {
      kind,
      labels: row.labels,
      manifest: { name: manifest.name, version: manifest.version, tracking },
      ...(seed ? { from: { agent: body.from!.agent, version: seed.version } } : {}),
      ...(row.forkedFrom ? { forkedFrom: row.forkedFrom } : {}),
    });
    if (fork)
      await t.agentEvent(fork.source, "agent.forked", {
        to: id,
        disk: seed?.version ?? null,
        manifest: { name: manifest.name, version: manifest.version },
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
  await armAgentTriggers(ctx, id);
  // A virtual fork's workspace is written at once (a pod's once its engine connects).
  if (body.from !== undefined && view.kind === "virtual") {
    await runPendingSeed(ctx, id);
    return getAgent(ctx, id, scope);
  }
  return view;
}

/**
 * The move a `PUT` naming `ref` asks of existing Agent `agent` (track T3): to version `n` for
 * `name@n` (pinned), else to the latest version (tracking), unless that one failed to start, when
 * it stays on what it runs. Another manifest name is `409 agent_fixed_field`.
 */
async function moveOf(t: Tx, agent: Environment, ref: { name: string; version?: number }): Promise<Move> {
  if (ref.name !== agent.manifestName)
    fail(
      409,
      `Agent ${agent.id} runs agent manifest ${agent.manifestName}, which is fixed for its life: fork it into a new Agent made from ${ref.name} with POST /v1/agents/${encodeURIComponent(agent.id)}/fork.`,
      { code: "agent_fixed_field", details: { fields: [{ field: "manifest", from: agent.manifestName, to: ref.name }] } },
    );
  const missing = (): never =>
    fail(404, `Agent manifest ${ref.name} has no version ${ref.version}.`, { code: "manifest_not_found" });
  let target = (await t.agentManifest(ref.name, ref.version)) ?? missing();
  if (ref.version === undefined && target.version === agent.failedVersion)
    target = (await t.agentManifest(ref.name, agent.manifestVersion)) ?? target;
  return planMove(t, agent, target, ref.version === undefined ? "tracking" : "pinned");
}

/**
 * `PUT /v1/agents/{id}?dryRun=true` (track T3): what moving existing Agent `id` to the version
 * `body.manifest` names would do (`AgentMovePlan`), with nothing changed.
 */
export async function planAgentPut(
  ctx: TenantContext,
  id: string,
  body: PutAgentRequest,
  scope: AuthScope,
): Promise<{ dryRun: true; plan: AgentMovePlan }> {
  reachable(agentGrantsOf(scope), id);
  const ref =
    parseAgentManifestRef(body.manifest) ??
    fail(400, "manifest is an agent manifest's name, or name@version such as triage@3.");
  return ctx.store.tx(async (t) => {
    const agent = (await liveEnvironment(t, id)) ?? fail(404, "Agent not found: a dry run plans the move of an existing Agent.");
    return { dryRun: true as const, plan: (await moveOf(t, agent, ref)).plan };
  });
}

/**
 * After a secret write on Agent `id`: a move that waited for its required secrets goes on once
 * they are set (track T3). Best effort: the write stands either way.
 */
export async function secretWritten(ctx: TenantContext, id: string): Promise<void> {
  try {
    await ctx.store.tx(async (t) => {
      const agent = await liveEnvironment(t, id, { lock: true });
      if (agent) await resumeMove(t, agent, new Date().toISOString());
    });
  } catch (error) {
    ctx.config.logger.warn("agent move not resumed after a secret write", {
      environmentId: id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
): Promise<PutAgentSecretRequest> {
  const request = await parseSecretRequest(ctx, id, name, raw);
  // Within the Tenant's Runtime limits `secretValueChars` and `secretHosts`, read for the write.
  const issues = secretRequestIssues(request, await ctx.store.tx((t) => readRuntimeLimits(t)));
  if (issues.length > 0) fail(400, issues.join(" "));
  return request;
}

async function parseSecretRequest(
  ctx: TenantContext,
  id: string,
  name: string,
  raw: unknown,
): Promise<PutAgentSecretRequest> {
  const { environment, slots } = await ctx.store.tx(async (t) => {
    const environment = await liveEnvironment(t, id);
    return { environment, slots: environment && (await slotsAhead(t, environment)) };
  });
  if (!environment || slots === undefined) return PutAgentSecretRequestSchema.parse(raw);
  const named = `${environment.manifestName}@${environment.targetVersion ?? environment.manifestVersion}`;
  const slot =
    slots[name] ??
    fail(
      409,
      `Agent ${id}'s manifest (${named}) declares no secret ${name}: add the slot to the manifest's runtime section, then move the Agent to the new version.`,
      { code: "secret_not_in_manifest", details: { declared: Object.keys(slots).sort() } },
    );
  const full = slotRequest(slot);
  if (raw !== null && typeof raw === "object" && "type" in raw) {
    const body = PutAgentSecretRequestSchema.parse(raw);
    // The gateway's tool prefix is this installation's to add (`gateway-credentials`).
    const { requestId: _, value: _v, headers: _h, toolPrefix: _p, ...binding } = body as PutAgentSecretRequest & {
      value?: string;
      headers?: unknown;
      toolPrefix?: string;
    };
    if (canonical(binding) !== canonical(full))
      fail(409, `Secret ${name}'s type and binding come from Agent ${id}'s manifest: send only its value ({ "value": "…" }).`, {
        code: "secret_not_in_manifest",
      });
    return body;
  }
  const { requestId, value, headers, toolPrefix } = PutAgentSecretValueRequestSchema.parse(raw);
  const withId = {
    ...(requestId === undefined ? {} : { requestId }),
    ...(toolPrefix === undefined ? {} : { toolPrefix }),
  };
  if (slot.type === "headers") {
    if (headers === undefined) fail(400, `Secret ${name} is a headers credential: send { "headers": { … } }.`);
    return PutAgentSecretRequestSchema.parse({ ...withId, ...full, headers });
  }
  if (value === undefined) fail(400, `Secret ${name} takes a value: send { "value": "…" }.`);
  return PutAgentSecretRequestSchema.parse({ ...withId, ...full, value });
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
  from: NonNullable<PutAgentRequest["from"]>,
): Promise<{ artifactId: string; version: number }> {
  if (kind === "none") fail(400, "from is for an Agent with a disk: kind none has none.");
  reachable(agentGrantsOf(scope), from.agent);
  const source = (await liveEnvironment(t, from.agent)) ?? notFound();
  const subject = subjectOf(scope);
  if (subject !== undefined && source.ownerUserId !== undefined && source.ownerUserId !== subject) notFound();
  return forkSeedOf(t, { environment: from.agent, version: from.version });
}

/** What a create does for a fork (`POST .../fork`); `copied` is filled in by the create. */
interface Fork {
  source: string;
  /** The manifest version the plan resolved, which the create makes the fork from. */
  version: number;
  setup: boolean;
  /**
   * The source's secrets sealed by keys for the new vault `vaultId` (F4.2), before the create's
   * transaction, which inserts them; absent with `secrets: none`.
   */
  sealed?: { vaultId: string; copies: SealedSecretCopies };
  copied?: { copied: string[]; dropped: string[] };
}

/**
 * `POST /v1/agents/{id}/fork` (Q15): copies an Agent into a new one, which is how an Agent changes
 * what is fixed for its life (its manifest, kind, harness or storage). A new Agent `body.id` is made from the manifest
 * (default the source's manifest name, tracking, at its latest version), its disk started from a
 * version of the source's (`latest` takes a snapshot first, refused during a turn), and its
 * secrets copied inside the Runtime. A fork onto other setup runs that setup on the copied disk
 * before its first turn (Q17). The source keeps what it runs, its disk and its sessions. With
 * `dryRun`, the plan only.
 */
export async function forkAgent(
  ctx: TenantContext,
  sourceId: string,
  body: ForkAgentRequest,
  scope: AuthScope,
): Promise<ForkAgentResponse> {
  const grants = agentGrantsOf(scope);
  reachable(grants, sourceId);
  reachable(grants, body.id);
  if (body.id === sourceId) fail(400, "A fork is a new Agent: give it another id.");
  const { plan: planned, slots } = await ctx.store.tx(async (t) => {
    const source = (await liveEnvironment(t, sourceId)) ?? notFound();
    const subject = subjectOf(scope);
    if (subject !== undefined && source.ownerUserId !== undefined && source.ownerUserId !== subject) notFound();
    const ref =
      body.manifest === undefined
        ? { name: source.manifestName }
        : (parseAgentManifestRef(body.manifest) ??
          fail(400, "manifest is an agent manifest's name, or name@version such as triage@3."));
    const manifest =
      (await t.agentManifest(ref.name, ref.version)) ??
      fail(
        404,
        ref.version === undefined
          ? `No agent manifest is named ${ref.name}.`
          : `Agent manifest ${ref.name} has no version ${ref.version}.`,
        { code: "manifest_not_found" },
      );
    const runtime = runtimeOf(manifest.body);
    const kind = runtime.kind;
    const resolved = resolveRecipe(kind, manifestRecipeRequest(manifest.body), effectiveSandboxConfig(await readSandboxConfig(t)));
    const errors = [
      ...(resolved.kind === "error" ? resolved.errors : []),
      ...limitIssues(runtime.limits, await readTenantLimits(t)),
      ...manifestShapeIssues(runtime, await readRuntimeLimits(t)),
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
    const plan: AgentForkPlan = {
      source: sourceId,
      id: body.id,
      kind,
      manifest: { name: manifest.name, version: manifest.version },
      disk,
      setup:
        kind === "pod" &&
        disk !== null &&
        canonical(recipe) !== canonical(source.applied) &&
        Boolean(recipe.setup?.length || recipe.files?.length),
      secrets: {
        copied,
        dropped: names.filter((item) => !copied.includes(item)),
        missing: (Object.entries(recipe.secrets ?? {}) as [string, EnvironmentSecretSlot][])
          .filter(([item, slot]) => slot.required === true && !copied.includes(item))
          .map(([item]) => item)
          .sort(),
      },
      changes: manifestChanges(source.applied, recipe),
      sessions: (await t.sessionsOnEnvironment(sourceId)).length,
      memories: await t.countMemories(sourceId),
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
  const fork: Fork = {
    source: sourceId,
    version: planned.manifest.version,
    setup: planned.setup,
    ...(sealed ? { sealed } : {}),
  };
  const agent = await putAgent(
    ctx,
    body.id,
    {
      ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
      // Tracking unless the request pinned a version; either way the plan's version is made.
      manifest: body.manifest ?? planned.manifest.name,
      ...(body.labels === undefined ? {} : { labels: body.labels }),
      ...(body.owner === undefined ? {} : { owner: body.owner }),
      ...(disk === null ? {} : { from: { agent: sourceId, version: disk } }),
    },
    scope,
    { fork },
  );
  const copied = fork.copied ?? { copied: [], dropped: planned.secrets.copied };
  const dropped = [...new Set([...planned.secrets.dropped, ...copied.dropped])].sort();
  return {
    agent,
    plan: {
      ...planned,
      disk,
      secrets: {
        copied: copied.copied,
        dropped,
        missing: Object.entries(agent.runtime.secrets ?? {})
          .filter(([item, slot]) => slot.required === true && !copied.copied.includes(item))
          .map(([item]) => item)
          .sort(),
      },
    },
  };
}

/** `GET /v1/agents/{id}`. */
export async function getAgent(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<AgentView> {
  reachable(agentGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    const environment = (await liveEnvironment(t, id)) ?? notFound();
    return viewOf(ctx, t, environment, subjectOf(scope));
  });
}

/**
 * What `GET /v1/agents` filters on: labels (all of them), the derived state, the manifest's name
 * and whether it is outdated.
 */
export interface AgentFilters {
  labels: Record<string, string>;
  state?: string;
  manifest?: string;
  /** Only Agents moving to another version (track T3): waiting for their secrets or their pod's start. */
  outdated?: boolean;
}

/**
 * `GET /v1/agents?label=k=v&state=s&manifest=m`: every Agent with all the labels, in the state
 * and made from the manifest, that the caller reaches, by id. With `page`, at most `limit` after
 * the Agent id `after` (the cursor), and the id to continue from.
 */
export async function listAgents(
  ctx: TenantContext,
  filters: AgentFilters,
  scope: AuthScope,
  page?: { limit: number; after?: string },
): Promise<{ agents: AgentView[]; next: string | null }> {
  const grants = agentGrantsOf(scope);
  return ctx.store.tx(async (t) => {
    const found = await t.listEnvironments({ labels: filters.labels });
    const views: AgentView[] = [];
    let next: string | null = null;
    for (const environment of found) {
      if (!live(environment) || (grants !== undefined && !agentGranted(grants, environment.id))) continue;
      if (filters.manifest !== undefined && environment.manifestName !== filters.manifest) continue;
      if (filters.outdated !== undefined && (environment.targetVersion !== undefined) !== filters.outdated) continue;
      if (page?.after !== undefined && environment.id <= page.after) continue;
      const view = await viewOf(ctx, t, environment, subjectOf(scope));
      if (filters.state !== undefined && view.state !== filters.state) continue;
      if (page !== undefined && views.length === page.limit) {
        next = views.at(-1)!.id;
        break;
      }
      views.push(view);
    }
    return { agents: views, next };
  });
}

/**
 * Asks pod Environment `id` to run when it is stopped or failed (a disk copy needs its engine),
 * with its recipe applied, as a turn start would.
 */
export async function wakePod(ctx: TenantContext, id: string): Promise<void> {
  if (!ctx.pods) fail(409, `Agent ${id} runs on a pod, and this Runtime has no sandbox pods.`, { code: "agent_unavailable" });
  await ctx.store.tx(async (t) => {
    const environment = await liveEnvironment(t, id, { lock: true });
    const pod = environment?.pod;
    if (!environment || !pod) return;
    if (pod.observed === "lost")
      fail(409, `Agent ${id}'s pod was lost (${pod.reason ?? "its volume is gone"}). Reset or restore it.`, {
        code: "agent_lost",
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
    failRetryLater(`Agent ${environment.id}'s disk is being copied (${environment.diskOp!.kind}). Try again shortly.`, "agent_busy");
}

/** Refused while a session that names Environment `id` has a turn running. */
async function refuseBusy(t: Tx, id: string): Promise<void> {
  const busy = (await t.sessionsOnEnvironment<Session>(id)).some(
    (session) => session.activeTurnId !== null,
  );
  if (busy)
    failRetryLater(`Agent ${id} has a turn running. Cancel it, or wait for it to end.`, "agent_busy");
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
  await t.agentEvent(id, "agent.deleted", { reason });
  // Its triggers and their runs go with it; a timer still armed finds no row.
  await t.deleteAgentTriggers(id);
  // So do its memories and their versions (T5).
  await t.deleteAgentMemories(id);
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
 * `DELETE /v1/agents/{id}`: deletes the Environment, its vault and its workspace. Refused
 * while a session that names it has an active turn. Sessions keep its id: their next turn is
 * refused (`agent_unavailable`) unless an Environment with this id exists again.
 */
export async function deleteAgent(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<{ id: string; deleted: boolean }> {
  reachable(agentGrantsOf(scope), id);
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
export async function sweepUnusedAgents(ctx: TenantContext, now = Date.now()): Promise<void> {
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
    return fail(400, `Agent ${id} is of kind ${environment.kind}: only a pod Agent stops and resets`);
  return environment as PodEnvironment;
}

/**
 * `POST /v1/agents/{id}/stop`: suspends a pod Environment. Its volume is kept, and the next
 * turn of a session that names it starts it again. Refused during a turn.
 */
export async function stopAgent(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<AgentView> {
  reachable(agentGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    const environment = await podEnvironment(t, id);
    await refuseBusy(t, id);
    const pod = environment.pod;
    const now = new Date().toISOString();
    if (pod.desired === "running" && pod.observed !== "lost") {
      const epoch = pod.hostEpoch + 1;
      await t.updateEnvironmentPod(id, { desired: "suspended", rev: pod.rev + 1, hostEpoch: epoch }, now);
      await t.agentEvent(id, "agent.suspended", { reason: "stop" });
      await reconcileAfter(t, id);
      await revokeHost(t, id, epoch);
    }
    await t.updateEnvironment(id, { lastUsedAt: now }, now);
    return viewOf(ctx, t, (await t.environment(id)) ?? environment, subjectOf(scope));
  });
}

/**
 * `POST /v1/agents/{id}/restart` (track T3): applies a pending version now, refused during a
 * turn. With `retry`, it first moves the Agent to the version that failed to start again. A
 * running pod stops, so the next turn starts it on the version; a stopped or failed one is asked
 * to run at once. Kinds `virtual` and `none` apply a version at once anyway.
 */
export async function restartAgent(
  ctx: TenantContext,
  id: string,
  options: { retry?: boolean },
  scope: AuthScope,
): Promise<AgentView> {
  reachable(agentGrantsOf(scope), id);
  return ctx.store.tx(async (t) => {
    let agent = (await liveEnvironment(t, id, { lock: true })) ?? notFound();
    await refuseBusy(t, id);
    refuseDiskCopy(agent);
    const now = new Date().toISOString();
    if (options.retry && agent.failedVersion !== undefined) {
      const failed =
        (await t.agentManifest(agent.manifestName, agent.failedVersion)) ??
        fail(404, `Agent manifest ${agent.manifestName} has no version ${agent.failedVersion}.`, { code: "manifest_not_found" });
      await moveAgent(t, agent, await planMove(t, agent, failed, agent.manifestRef), now);
      agent = (await t.environment(id, { lock: true }))!;
    }
    const pod = agent.pod;
    if (pod && waitingFor(agent) === "start") {
      if (!ctx.pods) fail(409, `Agent ${id} runs on a pod, and this Runtime has no sandbox pods.`, { code: "agent_unavailable" });
      if (pod.observed === "lost")
        fail(409, `Agent ${id}'s pod was lost (${pod.reason ?? "its volume is gone"}). Reset it to continue.`, { code: "agent_lost" });
      if (pod.desired === "running" && pod.observed !== "failed") {
        // Stopped now; the next turn starts it on the version.
        const epoch = pod.hostEpoch + 1;
        await t.updateEnvironmentPod(id, { desired: "suspended", rev: pod.rev + 1, hostEpoch: epoch }, now);
        await t.agentEvent(id, "agent.suspended", { reason: "restart" });
        await reconcileAfter(t, id);
        await revokeHost(t, id, epoch);
      } else {
        await wantRunning(t, agent as PodEnvironment, now);
        await reconcileAfter(t, id);
      }
    }
    await t.updateEnvironment(id, { lastUsedAt: now }, now);
    return viewOf(ctx, t, (await t.environment(id)) ?? agent, subjectOf(scope));
  });
}

/**
 * `POST /v1/agents/{id}/reset`: a new pod on a new, empty volume (the next volume
 * generation), with a new join token and the recipe applied; the old Sandbox and volume are
 * deleted. Leaves `lost` and `failed`. Refused during a turn, and while an earlier reset's
 * Sandbox is still being deleted.
 */
export async function resetAgent(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
): Promise<AgentView> {
  reachable(agentGrantsOf(scope), id);
  // A missing Environment is a 404, and one of another kind a 400, with or without sandbox pods.
  await ctx.store.tx((t) => podEnvironment(t, id));
  await requirePods(ctx.pods, "Resetting a pod Agent");
  return ctx.store.tx(async (t) => {
    const environment = await podEnvironment(t, id);
    await refuseBusy(t, id);
    refuseDiskCopy(environment);
    const pod = environment.pod;
    if (pod.retiring !== undefined)
      failRetryLater(`Agent ${id} is still deleting its previous volume. Try again shortly.`, "agent_busy");
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
  // A move whose runtime waits for a start switches now (track T3).
  await switchTo(t, environment, now);
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
              until: new Date(Date.now() + hostTuning().tenant.seedLeaseMs).toISOString(),
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
  await t.agentEvent(id, "agent.reset", {
    volumeGeneration: volumeGen,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.seed ? { from: { version: options.seed.version } } : {}),
  });
  await reconcileAfter(t, id);
  await revokeHost(t, id, epoch);
  return volumeGen;
}

/** `GET /v1/agents/{id}/events`: the Environment's lifecycle stream. */
export async function agentEventsOf(
  ctx: TenantContext,
  id: string,
  scope: AuthScope,
  query: AgentEventsQuery = {},
) {
  reachable(agentGrantsOf(scope), id);
  // One read returns at most the Tenant's Runtime limit `environmentEventItems`; `from` reads on.
  return ctx.store.tx(async (t) => ({
    events: await t.agentEvents(id, { ...query, limit: (await readRuntimeLimits(t)).environmentEventItems }),
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
    `Agent ${environment.id} is for another owner's sessions (its owner guard).`,
    { code: "agent_owner_mismatch" },
  );
}

/**
 * Opens a new session on Environment `id` (`PutSessionRequest.environment`): it must exist, be
 * reachable with `grants` and pass its owner guard. Runs in the session's transaction, after
 * its session row lock; holds the Environment's row lock.
 */
export async function openAgent(
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
export async function recordAttachment(t: Tx, sessionId: string, agentId: string) {
  await t.event(sessionId, null, "agent.attached", { agentId });
  await t.agentEvent(agentId, "agent.attached", { sessionId });
}

/**
 * Checks a turn start on a session that names an Environment, in the command's transaction
 * after the session row lock: the Environment still exists, a token caller's grants reach it,
 * its owner guard admits the session's owner, and no disk copy holds it. Other sessions' turns
 * do not stop it (D66). Holds the Environment row's lock until the transaction ends, so a turn
 * start and disk work on one Environment are decided one after the other.
 *
 * A pod Environment must also be usable: not lost (`agent_lost`), on a Runtime with
 * sandbox pods (`agent_unavailable`). A stopped or failed pod is asked to run again, with
 * its recipe applied, after the commit.
 */
export async function checkAgentTurn(
  t: Tx,
  session: Session,
  scope: AuthScope,
  ctx?: TenantContext,
): Promise<void> {
  const id = session.environmentId;
  if (id === undefined) return;
  const grants = agentGrantsOf(scope);
  if (grants !== undefined && !agentGranted(grants, id))
    fail(403, `This token does not reach Agent ${id}.`, { code: "agent_not_granted" });
  const environment = await liveEnvironment(t, id, { lock: true });
  if (!environment)
    return fail(409, `Agent ${id} was deleted. Create it again to continue this session.`, {
      code: "agent_unavailable",
    });
  if (environment.ownerUserId !== undefined && environment.ownerUserId !== session.ownerUserId)
    fail(403, `Agent ${id} is for another owner's sessions (its owner guard).`, {
      code: "agent_owner_mismatch",
    });
  // The harness the turn would run on (R4.1, Q9): a pod about to wake runs its recipe's. A
  // session never moves to another harness: its state is that harness's. An Environment's
  // harness never changes since protocol 14, so this refuses a session whose Environment id was
  // deleted and made again with another harness, and an Environment changed in place before
  // protocol 14 whose recipe (a pod's, at its wake) names another harness than it applied.
  const waking = environment.pod !== undefined && (environment.pod.desired !== "running" || environment.pod.observed === "failed");
  const runs = waking ? environment.recipe.harness : environment.applied.harness;
  if (!isWorkflowManifest(session.manifest) && runs !== harnessOf(session))
    fail(409, `Agent ${id} runs the ${runs} harness, and this session runs ${harnessOf(session)}: open a new session to run on it.`, {
      code: "harness_mismatch",
      details: { harness: harnessOf(session), agentHarness: runs },
    });
  if (environment.kind === "none") return;
  // A snapshot or restore copies the disk between turns (R2d step 3); a seed's turn waits.
  refuseDiskCopy(environment);
  const pod = environment.pod;
  if (!pod) return;
  if (!ctx?.pods)
    fail(409, `Agent ${id} runs on a pod, and this Runtime has no sandbox pods: run \`nylorun local sandbox enable --context <name>\`.`, {
      code: "agent_unavailable",
    });
  if (pod.observed === "lost")
    fail(409, `Agent ${id}'s pod was lost (${pod.reason ?? "its volume is gone"}). Reset it to continue.`, {
      code: "agent_lost",
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
      await t.agentEvent(environment.id, "agent.detached", {
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
export async function touchAgent(ctx: TenantContext, id: string): Promise<void> {
  try {
    await ctx.store.tx(async (t) => {
      const environment = await liveEnvironment(t, id, { lock: true });
      if (!environment) return;
      const now = new Date();
      const iso = now.toISOString();
      await t.updateEnvironment(id, { lastUsedAt: iso }, iso);
      if (!environment.pod || environment.pod.desired !== "running") return;
      await t.updateEnvironmentPod(id, { lastActiveAt: iso }, iso);
      const idleMs = idleMsOf(await readSandboxConfig(t), environment);
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
          at: Date.parse(row.pod.lastActiveAt ?? row.createdAt) + idleMsOf(config, row),
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
