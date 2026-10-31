/**
 * Session resources: `PUT /v1/sessions/:id` (create, or find an identical one), the session list
 * and the session view. A session runs on one Agent (protocol 16) and pins the manifest version
 * the Agent runs when it opens; each turn takes the version the Agent runs then
 * (`agent-versions.ts`). Reads use the store's typed queries; `PUT /v1/sessions/:id` runs in
 * one transaction with the Agent's checks.
 */
import { type PutSessionRequest } from "@nylorun/core/contracts";
import { aggregateWaits, isWorkflowManifest } from "../core/flow-host.js";
import { canonical } from "../store/canonical.js";
import type { Environment, Tx } from "../store/types.js";
import { readSandboxConfig } from "../sandbox/tenant-config.js";
import { checkPlacement, requirePods } from "../sandbox/placement.js";
import { pinOf } from "./agent-versions.js";
import { openAgent, recordAttachment } from "./agents.js";
import {
  harnessOf,
  reachesAgent,
  type Session,
  type SessionAccess,
  type TenantContext,
} from "./context.js";
import { fail } from "./http.js";
import { definitionFileIssues } from "./definition-files.js";
import { agentModelOf } from "./session-model.js";
import { limitsInForce, readTenantLimits } from "./limits.js";

/** A session's creation identity: everything but the request id. */
const sessionIdentity = (value: any): string => {
  const { requestId: _requestId, ...body } = value ?? {};
  return canonical(body);
};

/**
 * `access`, when the request acts for a person, limits the list to that person's sessions on
 * the Agents they may use.
 */
export async function listSessions(
  ctx: TenantContext,
  agentId: string | null,
  access?: SessionAccess
) {
  const sessions = await ctx.store.tx((t) =>
    t.listSessions<Session>({
      ...(agentId === null ? {} : { agentId }),
      ...(access === undefined ? {} : { ownerUserId: access.owner }),
    })
  );
  return {
    sessions: sessions
      .filter((s) => reachesAgent(access, s.agentId))
      .map((s) => ({
      id: s.id,
      agentId: s.agentId,
      ownerUserId: s.ownerUserId,
      status: s.status,
      activeTurnId: s.activeTurnId,
    })),
  };
}

/**
 * Create a session on an Agent, or find an identical one. `access`, when the request acts for a
 * subject, must be the session's owner: another owner's session id is the 404 of a missing one
 * (not the 409 of a mismatch), and so is an Agent whose owner guard names another owner.
 *
 * The session runs on its Agent for its life: the Agent's sandbox (kinds `virtual` and `pod`) is
 * the session's, with the spec of what the Agent runs pinned now, and the Agent's vault holds the
 * session's credentials. It pins the manifest version the Agent runs (`definition`), as the loop
 * manifest that version's harness section makes, and the harness that section names (`pinOf`);
 * a turn's first segment pins the version the Agent runs then (`repinTurn`). When that version
 * names a model the Tenant can use (`harness.model`), the session starts with it as its own.
 */
export async function putSession(
  ctx: TenantContext,
  id: string,
  body: PutSessionRequest,
  access?: SessionAccess,
  options: {
    /**
     * Create the session if it is missing and otherwise leave it as it is (an AG-UI thread's
     * session): an existing one must have the same owner and Agent, or it is a 404.
     */
    createOnly?: boolean;
    /**
     * The Agents the caller reaches (a token caller's grants, `agentGrantsOf`); undefined
     * reaches every one. `agent` must name one of them.
     */
    agentGrants?: readonly string[];
  } = {}
): Promise<Session> {
  const opaque = access !== undefined;
  if (opaque && body.ownerUserId !== access.owner)
    fail(403, "ownerUserId must be the subject");
  // An Agent the subject may not use is the 404 of a missing one.
  if (!reachesAgent(access, body.agent)) fail(404, "Agent not found");
  return ctx.store.tx((t) => openSessionIn(ctx, t, id, body, access, options));
}

/**
 * `putSession`'s work in transaction `t`: also how a trigger's first run opens the session it
 * names (track T4), in the run's transaction.
 */
export async function openSessionIn(
  ctx: TenantContext,
  t: Tx,
  id: string,
  body: PutSessionRequest,
  access?: SessionAccess,
  options: { createOnly?: boolean; agentGrants?: readonly string[] } = {}
): Promise<Session> {
  const opaque = access !== undefined;
  const prior = await t.lockSession<Session>(id);
  if (opaque && prior && (prior.ownerUserId !== access.owner || !reachesAgent(access, prior.agentId)))
    fail(404, "Session not found");
  if (prior && options.createOnly) {
    if (prior.ownerUserId !== body.ownerUserId || prior.agentId !== body.agent)
      fail(404, "Session not found");
    return prior;
  }
  if (prior) {
    if (sessionIdentity(prior.creation) !== sessionIdentity(body))
      fail(409, "Session already exists with different creation parameters");
    return prior;
  }
  const agent = await openAgent(t, body.agent, {
    ...(options.agentGrants === undefined ? {} : { grants: options.agentGrants }),
    ownerUserId: body.ownerUserId,
    opaque,
  });
  // The version the Agent runs, both sections (T3): its loop manifest, harness and sandbox spec.
  const { pin, version } = await pinOf(t, agent);
  await checkSkillLimit(t, pin.manifest, agent);
  const config = await readSandboxConfig(t);
  // Placement (D38, D52): where this session's harness may run, decided now and kept.
  checkPlacement(config, agent.kind, pin.harness);
  if (agent.kind === "pod") await requirePods(ctx.pods, `Agent ${agent.id}`);
  // The model the version names (`harness.model`, Host feature `agent-model`) is the new
  // session's own, as `chooseSessionModel` would make it, when the Tenant can use it now.
  const model = await agentModelOf(t, version.body.harness as { readonly model?: unknown });
  const created: Session = {
    id,
    agentId: agent.id,
    ownerUserId: body.ownerUserId,
    manifest: pin.manifest,
    manifestHash: pin.manifestHash,
    definition: { ...pin.definition },
    ...(pin.loop === undefined ? {} : { loop: pin.loop }),
    info: body.info,
    status: "idle",
    activeTurnId: null,
    creation: body,
    harness: pin.harness,
    environmentId: agent.id,
    environmentVersion: agent.version,
    ...(pin.sandbox === undefined ? {} : { sandbox: pin.sandbox }),
    ...(model === undefined ? {} : { model }),
  };
  await t.put("sessions", id, created);
  await recordAttachment(t, id, agent.id);
  return created;
}

/**
 * Refuses a session whose Agent's manifest carries a skill larger than the Agent allows now: its
 * manifest's `limits.skills.totalBytes`, else the Tenant's, never above the Tenant's, which may
 * have been lowered since the manifest was saved. `413 limit_exceeded`, with each skill and its
 * size in `details.skills`.
 */
async function checkSkillLimit(t: Tx, manifest: unknown, agent: Environment): Promise<void> {
  const limitBytes = limitsInForce(await readTenantLimits(t), agent.applied.limits).skills.totalBytes;
  const { oversized } = await definitionFileIssues(t, manifest, limitBytes);
  if (oversized.length === 0) return;
  fail(
    413,
    `Agent ${agent.id} allows a skill's files at most ${limitBytes} bytes together, and its manifest carries ${oversized.map((skill) => `'${skill.name}' (${skill.bytes})`).join(", ")}.`,
    { code: "limit_exceeded", details: { limitBytes, skills: oversized } },
  );
}

/** The session resource returned by `GET`/`PUT /v1/sessions/:id`. */
export async function sessionView(t: Tx, s: Session): Promise<unknown> {
  let waits: unknown = Array.isArray(s.waits)
    ? s.waits.map((call: any) => ({
        invocationId: call.invocationId,
        interaction: call.interaction,
        wait: call.wait,
        status: call.status,
      }))
    : s.waits;
  if (isWorkflowManifest(s.manifest)) {
    const aggregated = await aggregateWaits({ t, workflowSessionId: s.id });
    if (aggregated.length > 0) waits = aggregated;
  }
  const uncertain = await t.effectsForSession<any>(s.id, {
    statuses: ["uncertain"],
  });
  return {
    id: s.id,
    agentId: s.agentId,
    ownerUserId: s.ownerUserId,
    manifest: s.definition ?? null,
    manifestHash: s.manifestHash,
    status: s.status,
    activeTurnId: s.activeTurnId,
    queuedMessages: await t.countQueuedMessages(s.id),
    harness: harnessOf(s),
    ...(s.closedReason === undefined ? {} : { closedReason: s.closedReason }),
    mcpSnapshot: s.mcpSnapshot ?? null,
    mcpDiagnostics: s.mcpDiagnostics ?? [],
    waits,
    error: s.error,
    uncertainEffects: uncertain.map((e) => ({
      effectId: e.request.effectId,
      turnId: e.request.turnId,
      kind: e.request.kind,
      error: e.error,
    })),
  };
}
