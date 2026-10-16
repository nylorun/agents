/**
 * An Agent's versions (track T3, D73): which version of its agent manifest a session's turn runs.
 *
 * - **One version at a time.** An Agent runs one version of its manifest (`manifestVersion`),
 *   both sections together: the loop manifest its harness section makes, and the runtime its
 *   compute applies (`applied`). A session pins all of it (`pinOf`) when it opens.
 * - **A turn takes the Agent's version.** A turn's first segment re-pins its session to the
 *   version the Agent runs when that changed since the session's last turn (`repinTurn`), before
 *   anything of the turn has run: no effect is journaled for it yet. The turn keeps that version
 *   through every later segment, approval and rollover. A turn whose message named a variant,
 *   and a flow's sessions, keep the version they pinned.
 *
 * Re-pinning at the first segment, not when the message is accepted, keeps a turn that waits for
 * its compute to start on a version the Agent has at that start.
 */
import { hashManifest } from "@nylorun/core/compatibility";
import { loopManifestOf, type SandboxManifest } from "@nylorun/core/define";
import { isWorkflowManifest } from "../core/flow-host.js";
import type { AgentManifestRow, Environment, Tx } from "../store/types.js";
import { sandboxSpecOf } from "../sandbox/resolve.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import { HARNESS_ID } from "../sandbox/placement.js";
import { harnessOf, type Session } from "./context.js";
import { fail } from "./http.js";

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
