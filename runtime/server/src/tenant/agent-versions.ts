/**
 * An Agent's versions (track T3, D73): which version of its agent manifest it runs, how it moves
 * to another, and which version a session's turn runs.
 *
 * - **One version at a time.** An Agent runs one version of its manifest (`manifestVersion`),
 *   both sections together: the loop manifest its harness section makes, and the runtime its
 *   compute applies (`applied`). A session pins all of it (`pinOf`) when it opens.
 * - **A move** (`moveAgent`: `PUT /v1/agents/{id}`, and a save for each Agent that tracks the
 *   manifest) changes no data: its id, disk, vault and sessions stay. A version whose runtime a
 *   pod applies only when it starts (`START_FIELDS`) makes the Agent outdated (`targetVersion`,
 *   with the target's runtime in `recipe`) until its pod's next start switches it (`switchTo`);
 *   any other applies at once. A version that adds a required secret with no value the version
 *   can use waits for it (`resumeMove` after each secret write). Its manifest's name, kind,
 *   harness and storage are fixed for its life (`409 agent_fixed_field`).
 * - **The start check** (pods): a start on a new version records what ran before
 *   (`startCheck`) until the new pod's harness joins (`passStartCheck`). A failed setup, a failed
 *   pod or a start past the Host's `tenant.upgradeStartMs` goes back to it (`revertStart`): the
 *   definition, not the data. The version is the Agent's `failedVersion`, which a tracking Agent
 *   does not move to again, until a start on a new version succeeds. While a pod waits to start
 *   on a new version, it idles at most `tenant.upgradeIdleMs` (`idleMsOf`).
 * - **A turn takes the Agent's version.** A turn's first segment re-pins its session to the
 *   version the Agent runs when that changed since the session's last turn (`repinTurn`), before
 *   anything of the turn has run: no effect is journaled for it yet. The turn keeps that version
 *   through every later segment, approval and rollover. A turn whose message named a variant,
 *   and a flow's sessions, keep the version they pinned.
 *
 * Re-pinning at the first segment, not when the message is accepted, keeps a turn that waits for
 * its compute to start on a version the Agent has at that start.
 */
import type { AgentMovePlan, EnvironmentRecipe, EnvironmentSecretSlot } from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import { loopManifestOf, runtimeOf, type SandboxManifest } from "@nylorun/core/define";
import { isWorkflowManifest } from "../core/flow-host.js";
import { canonical } from "../store/canonical.js";
import type { AgentManifestRow, Environment, Tx } from "../store/types.js";
import { resolveRecipe, sandboxSpecOf } from "../sandbox/resolve.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import { HARNESS_ID } from "../sandbox/placement.js";
import { slotHolds } from "../vault/service.js";
import { manifestRecipeRequest, sectionChanges } from "./agent-manifests.js";
import { podLifecycleConfig } from "../sandbox/pods/spec.js";
import type { TenantSandboxConfig } from "../sandbox/tenant-config.js";
import { hostTuning } from "../tuning.js";
import { harnessOf, type Session, type TenantContext } from "./context.js";
import { fail } from "./http.js";
import { limitIssues, manifestShapeIssues, readTenantLimits } from "./limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";

/** What a session pins of the version its Agent runs. */
export interface SessionPin {
  /** The loop manifest the version's harness section makes (`loopManifestOf`). */
  readonly manifest: any;
  readonly manifestHash: string;
  readonly definition: { readonly name: string; readonly version: number };
  /** The version's `harness.loop`, when it sets one. */
  readonly loop?: Record<string, unknown>;
  /** The harness that runs its turns: the runtime's, or ours for a flow. */
  readonly harness: string;
  /** The sandbox spec of the runtime the Agent's compute runs (kinds `virtual` and `pod`). */
  readonly sandbox?: SandboxManifest;
}

/**
 * The pin of the version Agent `agent` runs: its manifest version's loop manifest, and the
 * harness and sandbox spec of the runtime its compute applies (`applied`). `409 agent_unavailable`
 * when that version is gone.
 */
export async function pinOf(t: Tx, agent: Environment): Promise<{ pin: SessionPin; version: AgentManifestRow }> {
  const version =
    (await t.agentManifest(agent.manifestName, agent.manifestVersion)) ??
    fail(409, `Agent ${agent.id}'s manifest ${agent.manifestName}@${agent.manifestVersion} is gone.`, {
      code: "agent_unavailable",
    });
  const manifest = loopManifestOf(version.body);
  const config = await readSandboxConfig(t);
  const loop = version.body.harness.loop as Record<string, unknown> | undefined;
  const sandbox =
    agent.kind === "none" ? undefined : sandboxSpecOf(agent.applied, effectiveSandboxConfig(config).limits.idle);
  return {
    version,
    pin: {
      manifest,
      manifestHash: hashManifest(manifest as never),
      definition: { name: version.name, version: version.version },
      ...(loop === undefined ? {} : { loop }),
      harness: isWorkflowManifest(manifest) ? HARNESS_ID : agent.applied.harness,
      ...(sandbox === undefined ? {} : { sandbox }),
    },
  };
}

/** Writes `pin` onto `session` (the caller saves it). */
export function applyPin(session: Session, pin: SessionPin): void {
  session.manifest = pin.manifest;
  session.manifestHash = pin.manifestHash;
  session.definition = { ...pin.definition };
  if (pin.loop === undefined) delete session.loop;
  else session.loop = pin.loop;
  session.harness = pin.harness;
  if (pin.sandbox === undefined) delete session.sandbox;
  else session.sandbox = pin.sandbox;
}

/**
 * Re-pins `session` (in the segment's owned transaction) to the version its Agent runs, when its
 * active turn is about to run its first segment and nothing of the turn has run yet: the turn
 * then runs that version. Returns whether it changed the session (the caller saves it).
 *
 * Leaves the session as it is for a flow and a flow's linked session, a turn whose message named
 * a variant, a later segment, a turn with any journaled effect, and a version whose harness is
 * not the session's (an Agent's harness is fixed for its life, D73).
 */
export async function repinTurn(t: Tx, session: Session): Promise<boolean> {
  const id = session.environmentId;
  const checkpoint = session.checkpoint as { manifestHash?: string; segment?: number; turnId?: string } | undefined;
  if (id === undefined || session.definition === undefined || session.flowRootId !== undefined) return false;
  if (isWorkflowManifest(session.manifest) || session.activeTurnId === null) return false;
  if (!checkpoint || checkpoint.segment !== 0 || checkpoint.turnId !== session.activeTurnId) return false;
  // A variant the message named (a turn-manifest variant) is validated against the old pin.
  if (checkpoint.manifestHash !== session.manifestHash) return false;
  const agent = await t.environment(id);
  if (!agent) return false;
  if (session.definition.name === agent.manifestName && session.definition.version === agent.manifestVersion)
    return false;
  if ((await t.effectsForTurn(session.id, session.activeTurnId)).length > 0) return false;
  const { pin } = await pinOf(t, agent);
  if (pin.harness !== harnessOf(session)) return false;
  const changed = pin.manifestHash !== session.manifestHash;
  applyPin(session, pin);
  session.environmentVersion = agent.version;
  session.checkpoint = { ...(session.checkpoint as object), manifestHash: pin.manifestHash } as Session["checkpoint"];
  // MCP discovery is per loop manifest: the next one is the new version's.
  if (changed) {
    delete session.mcpSnapshot;
    delete session.mcpDiagnostics;
  }
  return true;
}

/** The runtime fields a pod applies only when it starts: a change waits for its next start. */
const START_FIELDS = ["image", "resources", "network", "setup", "files"] as const;

/** Whether pod Agent `agent` applies `recipe` only at its next start. */
function needsStart(agent: Environment, recipe: EnvironmentRecipe): boolean {
  return agent.kind === "pod" && START_FIELDS.some((field) => canonical(recipe[field]) !== canonical(agent.applied[field]));
}

/** What a move of `agent` to `target` would do, and the target's runtime resolved. */
export interface Move {
  plan: AgentMovePlan;
  target: AgentManifestRow;
  recipe: EnvironmentRecipe;
}

/**
 * The plan of moving `agent` to version `target` of its manifest, named `tracking` after it:
 * the target's runtime resolved against the Tenant's limits (a `400` when it no longer fits),
 * what it changes, the fixed fields it would change, and the required secrets it would wait for.
 */
export async function planMove(
  t: Tx,
  agent: Environment,
  target: AgentManifestRow,
  tracking: Environment["manifestRef"],
): Promise<Move> {
  const runtime = runtimeOf(target.body);
  const recipe = target.version === agent.manifestVersion ? agent.applied : await resolvedRuntime(t, target);
  const refusals: AgentMovePlan["refusals"] = [];
  const fixed = (field: string, from: unknown, to: unknown) => {
    if (canonical(from) !== canonical(to))
      refusals.push({ field, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });
  };
  fixed("kind", agent.kind, runtime.kind);
  fixed("harness", agent.applied.harness, recipe.harness);
  fixed("storage", agent.applied.storage, recipe.storage);
  const { missing, dormant } = await secretsOf(t, agent.id, recipe.secrets);
  const current = await t.agentManifest(agent.manifestName, agent.manifestVersion);
  const from = agent.manifestVersion;
  const applies: AgentMovePlan["applies"] =
    refusals.length > 0
      ? "refused"
      : target.version === from
        ? "none"
        : missing.length > 0
          ? "secrets"
          : needsStart(agent, recipe)
            ? "next_start"
            : "now";
  return {
    target,
    recipe,
    plan: {
      agent: agent.id,
      manifest: tracking === "tracking" ? target.name : `${target.name}@${target.version}`,
      from,
      to: target.version,
      tracking,
      applies,
      changes: target.version === from ? [] : sectionChanges(current?.body, target.body),
      missingSecrets: missing,
      dormantSecrets: dormant,
      refusals,
      sessions: (await t.sessionsOnEnvironment(agent.id)).length,
    },
  };
}

/**
 * Version `target`'s runtime resolved against the Tenant's limits now, as a create resolves it:
 * `400` when it no longer fits them. (What an Agent runs already stays, whatever its limits.)
 */
async function resolvedRuntime(t: Tx, target: AgentManifestRow): Promise<EnvironmentRecipe> {
  const runtime = runtimeOf(target.body);
  const resolved = resolveRecipe(runtime.kind, manifestRecipeRequest(target.body), effectiveSandboxConfig(await readSandboxConfig(t)));
  const errors = [
    ...(resolved.kind === "error" ? resolved.errors : []),
    ...limitIssues(runtime.limits, await readTenantLimits(t)),
    ...manifestShapeIssues(runtime, await readRuntimeLimits(t)),
  ];
  if (resolved.kind === "error" || errors.length > 0)
    return fail(400, `${target.name}@${target.version} does not fit this Tenant's limits now: ${errors.join(" ")}`);
  return resolved.recipe;
}

/**
 * Of Agent `id`'s vault and the secret slots `slots` of a version: each required slot with no
 * value that fills it (`slotHolds`), and each secret that fills none, which stays dormant.
 */
async function secretsOf(
  t: Tx,
  id: string,
  slots: Record<string, EnvironmentSecretSlot> | undefined,
): Promise<{ missing: string[]; dormant: string[] }> {
  const vault = await t.vaultOfEnvironment(id);
  const rows = vault ? (await t.credentialsForVault(vault.id)).filter((row) => row.type !== "model") : [];
  if (slots === undefined) return { missing: [], dormant: [] };
  const fills = (name: string) => rows.some((row) => row.name === name && slotHolds(slots[name]!, row));
  return {
    missing: Object.entries(slots)
      .filter(([name, slot]) => slot.required === true && !fills(name))
      .map(([name]) => name)
      .sort(),
    dormant: rows
      .filter((row) => slots[row.name] === undefined || !slotHolds(slots[row.name]!, row))
      .map((row) => row.name)
      .sort(),
  };
}

/** The `409 agent_fixed_field` of a move that would change what is fixed for an Agent's life. */
export function refuseFixed(agentId: string, plan: Pick<AgentMovePlan, "refusals" | "to" | "from">): never {
  return fail(
    409,
    `Agent ${agentId}'s ${plan.refusals.map((refusal) => refusal.field).join(", ")} ${plan.refusals.length === 1 ? "is" : "are"} fixed for its life, and version ${plan.to} changes ${plan.refusals.length === 1 ? "it" : "them"}: fork it into a new Agent with POST /v1/agents/${encodeURIComponent(agentId)}/fork.`,
    { code: "agent_fixed_field", details: { fields: plan.refusals, from: plan.from, to: plan.to } },
  );
}

/**
 * Moves `agent` (locked, live) per `move` (`planMove`), in the caller's transaction. A move
 * replaces a pending one: the runtime it waited to apply is dropped first. `none` (back to what it
 * runs) only clears the target; `now` switches; `next_start` keeps the target's runtime in
 * `recipe` for the pod's next start (`switchTo`); `secrets` names the target and waits.
 * Returns when it applies.
 */
export async function moveAgent(t: Tx, agent: Environment, move: Move, now: string): Promise<AgentMovePlan["applies"]> {
  const { plan, target, recipe } = move;
  if (plan.applies === "refused") refuseFixed(agent.id, plan);
  // Asked again while it waits for secrets: nothing new.
  if (plan.applies === "secrets" && agent.targetVersion === plan.to && agent.appliedVersion === agent.version) {
    if (agent.manifestRef !== plan.tracking) await t.updateEnvironment(agent.id, { manifestRef: plan.tracking }, now);
    return plan.applies;
  }
  const pending = agent.appliedVersion !== agent.version;
  // What it runs, with no pending runtime: the base every move starts from.
  const version = pending ? agent.version + 1 : agent.version;
  const base = pending ? { recipe: agent.applied, version, appliedVersion: version } : {};
  const ref = { manifestRef: plan.tracking };
  switch (plan.applies) {
    case "none":
      await t.updateEnvironment(agent.id, { ...base, ...ref, targetVersion: null }, now);
      break;
    case "secrets":
      await t.updateEnvironment(agent.id, { ...base, ...ref, targetVersion: plan.to }, now);
      await t.agentEvent(agent.id, "agent.outdated", { from: plan.from, to: plan.to, waitingFor: "secrets" });
      break;
    case "next_start":
      // `applied` stays what runs: `recipe` differs from it until the start applies it.
      await t.updateEnvironment(agent.id, { ...ref, recipe, version: agent.version + 1, targetVersion: plan.to }, now);
      await t.agentEvent(agent.id, "agent.outdated", { from: plan.from, to: plan.to, waitingFor: "start" });
      // A running pod stops sooner once idle, so its next start applies the version.
      if (agent.pod?.desired === "running") {
        const idleMs = Math.min(podLifecycleConfig(await readSandboxConfig(t), recipe).idleMs, hostTuning().tenant.upgradeIdleMs);
        const at = Math.max(Date.parse(agent.pod.lastActiveAt ?? now) + idleMs, Date.parse(now));
        await t.signalSandbox(agent.id, { kind: "arm", timer: "idle", at });
      }
      break;
    case "now":
      await t.updateEnvironment(
        agent.id,
        {
          ...ref,
          recipe,
          applied: recipe,
          version: version + 1,
          appliedVersion: version + 1,
          manifestVersion: target.version,
          manifestHash: target.hash,
          targetVersion: null,
          failedVersion: null,
        },
        now,
      );
      await t.agentEvent(agent.id, "agent.version_changed", { from: plan.from, to: plan.to });
      break;
  }
  return plan.applies;
}

/**
 * After a secret write: an Agent that waits for its secrets moves on once the target's required
 * slots are filled (`moveAgent` again, to the same target). In the caller's transaction.
 */
export async function resumeMove(t: Tx, agent: Environment, now: string): Promise<void> {
  if (agent.targetVersion === undefined || agent.appliedVersion !== agent.version) return;
  const target = await t.agentManifest(agent.manifestName, agent.targetVersion);
  if (!target) return void (await t.updateEnvironment(agent.id, { targetVersion: null }, now));
  const move = await planMove(t, agent, target, agent.manifestRef);
  if (move.plan.applies === "refused") return;
  await moveAgent(t, agent, move, now);
}

/**
 * At a pod Agent's start (`wantRunning`, `newVolume`): switches `agent` (locked) to the version it
 * moves to when its runtime waits for this start. Applies the target's runtime and version, drops
 * the pinned image digest when the image changed, and records what ran before (`startCheck`)
 * until the new pod's harness joins. Returns whether it switched.
 */
export async function switchTo(t: Tx, agent: Environment, now: string): Promise<boolean> {
  if (agent.targetVersion === undefined || agent.appliedVersion === agent.version) return false;
  const target = await t.agentManifest(agent.manifestName, agent.targetVersion);
  if (!target) return false;
  // A start that replaces one still being checked goes back as far as that one would.
  const from = agent.startCheck?.from ?? {
    manifestVersion: agent.manifestVersion,
    manifestHash: agent.manifestHash,
    applied: agent.applied,
    ...(agent.pod?.imageDigest === undefined ? {} : { imageDigest: agent.pod.imageDigest }),
  };
  await t.updateEnvironment(
    agent.id,
    {
      applied: agent.recipe,
      appliedVersion: agent.version,
      manifestVersion: target.version,
      manifestHash: target.hash,
      targetVersion: null,
      ...(agent.pod ? { startCheck: { from, startedAt: now } } : {}),
    },
    now,
  );
  if (agent.pod?.imageDigest !== undefined && canonical(agent.recipe.image) !== canonical(agent.applied.image))
    await t.updateEnvironmentPod(agent.id, { imageDigest: null }, now);
  await t.agentEvent(agent.id, "agent.version_changed", { from: agent.manifestVersion, to: target.version });
  return true;
}

/** What an outdated Agent waits for: its secrets, or its pod's next start; `null` when it is not. */
export function waitingFor(agent: Pick<Environment, "targetVersion" | "appliedVersion" | "version">): "secrets" | "start" | null {
  if (agent.targetVersion === undefined) return null;
  return agent.appliedVersion === agent.version ? "secrets" : "start";
}

/** How long pod Agent `agent` may idle before it stops: shorter while a start would apply a new version. */
export function idleMsOf(config: TenantSandboxConfig, agent: Environment): number {
  const idleMs = podLifecycleConfig(config, agent.recipe).idleMs;
  return waitingFor(agent) === "start" ? Math.min(idleMs, hostTuning().tenant.upgradeIdleMs) : idleMs;
}

/**
 * The harness of pod Agent `id` joined at host epoch `epoch` (its `hello`): a start on a new
 * version succeeded, setup included. Clears the start check and the failed version.
 */
export async function passStartCheck(ctx: TenantContext, id: string, epoch: number): Promise<void> {
  await ctx.store.tx(async (t) => {
    const agent = await t.environment(id, { lock: true });
    if (!agent?.startCheck || agent.pod?.hostEpoch !== epoch) return;
    await t.updateEnvironment(id, { startCheck: null, failedVersion: null }, new Date().toISOString());
  });
}

/**
 * Pod Agent `agent` (locked) did not start on the version it switched to (`reason`): back to what
 * it ran before (`startCheck.from`), its definition and not its data, with that version as its
 * `failedVersion`, and its pod asked to run again. A turn waiting for the start runs on the
 * version it went back to. Returns whether there was a start to go back from.
 */
export async function revertStart(t: Tx, agent: Environment, reason: string, now: string): Promise<boolean> {
  const check = agent.startCheck;
  const pod = agent.pod;
  if (!check || !pod) return false;
  const version = agent.version + 1;
  await t.updateEnvironment(
    agent.id,
    {
      recipe: check.from.applied,
      applied: check.from.applied,
      version,
      appliedVersion: version,
      manifestVersion: check.from.manifestVersion,
      manifestHash: check.from.manifestHash,
      targetVersion: null,
      failedVersion: agent.manifestVersion,
      startCheck: null,
    },
    now,
  );
  await t.updateEnvironmentPod(
    agent.id,
    {
      imageDigest: check.from.imageDigest ?? null,
      desired: "running",
      rev: pod.rev + 1,
      observed: "creating",
      startedAt: now,
      lastActiveAt: now,
      reason: null,
    },
    now,
  );
  await t.agentEvent(agent.id, "agent.start_failed", {
    from: check.from.manifestVersion,
    to: agent.manifestVersion,
    reason,
    reverted: true,
  });
  await t.agentEvent(agent.id, "agent.version_changed", { from: agent.manifestVersion, to: check.from.manifestVersion });
  await t.signalSandbox(agent.id, { kind: "reconcile" });
  return true;
}

/**
 * The Tenant sweep: each pod Agent whose start on a new version has taken longer than the Host's
 * `tenant.upgradeStartMs` goes back to the version it ran (`revertStart`).
 */
export async function sweepStartChecks(ctx: TenantContext, now = Date.now()): Promise<void> {
  const limit = hostTuning().tenant.upgradeStartMs;
  const due = (agent: Environment) => agent.startCheck !== undefined && Date.parse(agent.startCheck.startedAt) + limit <= now;
  for (const candidate of (await ctx.store.tx((t) => t.listEnvironments())).filter(due)) {
    try {
      await ctx.store.tx(async (t) => {
        const agent = await t.environment(candidate.id, { lock: true });
        if (!agent || !due(agent)) return;
        await revertStart(t, agent, `The pod did not start within ${Math.round(limit / 1000)} s`, new Date(now).toISOString());
      });
    } catch (error) {
      ctx.config.logger.warn("agent start check not swept", {
        environmentId: candidate.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
