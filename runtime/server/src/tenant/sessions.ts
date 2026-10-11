/**
 * Session and definition resources: `PUT/GET /v1/agents`, `PUT /v1/sessions/:id` (create, or
 * find an identical one), the session list and the session view. Reads use the store's typed
 * queries; `PUT /v1/sessions/:id` runs in one transaction with the Environment's checks.
 */
import {
  DefinitionDocumentSchema,
  definitionFilesOf,
  type PutAgentRequest,
  type PutSessionRequest,
} from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import { codeToolRefusal, type AgentManifest, type SandboxManifest } from "@nylorun/core/define";
import { aggregateWaits, isWorkflowManifest } from "../core/flow-host.js";
import { canonical } from "../store/canonical.js";
import type { Tx } from "../store/types.js";
import { sandboxSpecOf } from "../sandbox/resolve.js";
import { withPlatformTools, withSandboxCapability } from "../sandbox/session-sandbox.js";
import { declaredSandboxes } from "../sandbox/share.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import { HARNESS_ID, checkPlacement, requirePods } from "../sandbox/placement.js";
import { openEnvironment, recordAttachment } from "./environments.js";
import {
  harnessOf,
  type Session,
  type SessionAccess,
  type TenantContext,
} from "./context.js";
import { fail } from "./http.js";
import { missingDefinitionFiles } from "./definition-files.js";

/** A session's creation identity: everything but the request id. */
const sessionIdentity = (value: any): string => {
  const { requestId: _requestId, ...body } = value ?? {};
  return canonical(body);
};

interface Definition {
  manifest: any;
  manifestHash: string;
  implementationVersion: string;
}

export async function listDefinitions(ctx: TenantContext) {
  const definitions = await ctx.store.tx((t) =>
    t.listDefinitions<Definition>()
  );
  return {
    agents: definitions.map((d) => ({
      agentId: d.manifest.id,
      manifest: d.manifest,
      manifestHash: d.manifestHash,
      implementationVersion: d.implementationVersion,
    })),
  };
}

/**
 * The agents a token caller may see: id, name and description only, never
 * instructions, tools or MCP servers, and only the agents allowed.
 */
export async function listAgentsPublic(
  ctx: TenantContext,
  agents: ReadonlySet<string> | "*"
) {
  const definitions = await ctx.store.tx((t) =>
    t.listDefinitions<Definition>()
  );
  return {
    agents: definitions
      .filter((d) => agents === "*" || agents.has(d.manifest.id))
      .map((d) => ({
        agentId: d.manifest.id as string,
        ...(typeof d.manifest.name === "string" ? { name: d.manifest.name } : {}),
        ...(typeof d.manifest.description === "string"
          ? { description: d.manifest.description }
          : {}),
      })),
  };
}

export async function putDefinition(
  ctx: TenantContext,
  agentId: string,
  body: PutAgentRequest
) {
  if (body.manifest.id !== agentId) fail(400, "Agent id mismatch");
  DefinitionDocumentSchema.parse(body.manifest);
  // The Runtime runs agents from their manifests alone (track R2): no tool may need it.
  const code = codeToolRefusal(body.manifest);
  if (code) fail(400, code);
  const declared = declaredSandboxes(body.manifest);
  if (declared.length > 0)
    fail(
      400,
      `${declared.join(", ")} declares a sandbox. Agents no longer declare one: remove .sandbox(), create an Environment with the sandbox (PUT /v1/environments/{id}) and open the session on it, createSession({ environment }). See MIGRATION.md.`
    );
  const definition = {
    ...body,
    manifestHash: hashManifest(body.manifest as any),
  };
  const files = [...definitionFilesOf(body.manifest)];
  await ctx.store.tx(async (t) => {
    const missing = await missingDefinitionFiles(t, body.manifest);
    if (missing.length > 0)
      fail(
        400,
        `The definition names ${missing.length} file(s) the Runtime does not hold; upload each with PUT /v1/files/<sha256> first: ${missing.join(", ")}`,
        { code: "definition_files_missing", details: { missing } }
      );
    await t.put("definitions", agentId, definition);
    await t.insertDefinitionFileUses(agentId, definition.manifestHash, files);
  });
  return {
    agentId,
    manifestHash: definition.manifestHash,
    implementationVersion: body.implementationVersion,
  };
}

/**
 * `access`, when the request acts for a person, limits the list to that person's sessions of
 * the agents they may use.
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
  const allowed = access?.agents;
  return {
    sessions: sessions
      .filter((s) => allowed === undefined || allowed.has(s.agentId))
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
 * Create a session from its definition, or find an identical one. `access`, when the request
 * acts for a subject, must be the session's owner: another owner's session id is the 404 of a
 * missing one (not the 409 of a mismatch), and so is an Environment whose owner guard names
 * another owner.
 *
 * The session's Environment is fixed for its life: its sandbox (kinds `virtual` and `pod`) is
 * the session's, with the spec of the Environment's applied recipe pinned now, and its vault
 * holds the session's credentials. Without one the session has no sandbox and no credentials.
 */
export async function putSession(
  ctx: TenantContext,
  id: string,
  body: PutSessionRequest,
  access?: SessionAccess,
  options: {
    /**
     * Create the session if it is missing and otherwise leave it as it is (an AG-UI thread's
     * session): an existing one must have the same owner and agent, or it is a 404.
     */
    createOnly?: boolean;
    /**
     * The Environments the caller reaches (a token caller's grants, `environmentGrantsOf`);
     * undefined reaches every one. `environment` must name one of them.
     */
    environmentGrants?: readonly string[];
  } = {}
): Promise<Session> {
  const opaque = access !== undefined;
  if (opaque && body.ownerUserId !== access.owner)
    fail(403, "ownerUserId must be the subject");
  // An agent the subject may not use is the 404 of a missing definition.
  if (access?.agents !== undefined && !access.agents.has(body.agentId))
    fail(404, "Definition not found");
  return ctx.store.tx(async (t) => {
    const prior = await t.lockSession<Session>(id);
    if (
      opaque &&
      prior &&
      (prior.ownerUserId !== access.owner ||
        (access.agents !== undefined && !access.agents.has(prior.agentId)))
    )
      fail(404, "Session not found");
    if (prior && options.createOnly) {
      if (
        prior.ownerUserId !== body.ownerUserId ||
        prior.agentId !== body.agentId
      )
        fail(404, "Session not found");
      return prior;
    }
    if (prior) {
      if (sessionIdentity(prior.creation) !== sessionIdentity(body))
        fail(409, "Session already exists with different creation parameters");
      return prior;
    }
    const definition =
      (await t.get<Definition>("definitions", body.agentId)) ??
      fail(404, "Definition not found");
    const environment =
      body.environment === undefined
        ? undefined
        : await openEnvironment(t, body.environment, {
            ...(options.environmentGrants === undefined ? {} : { grants: options.environmentGrants }),
            ownerUserId: body.ownerUserId,
            opaque,
          });
    const config = await readSandboxConfig(t);
    // The harness the session runs for its life (R4.1): its Environment's, else ours. A flow
    // runs in core and our engine, whatever its Environment names.
    const harness =
      isWorkflowManifest(definition.manifest) || environment === undefined
        ? HARNESS_ID
        : environment.applied.harness;
    // Placement (D38, D52): where this session's harness may run, decided now and kept.
    checkPlacement(config, environment?.kind, harness);
    if (environment?.kind === "pod") await requirePods(ctx.pods, `Environment ${environment.id}`);
    const spec =
      environment === undefined || environment.kind === "none"
        ? undefined
        : sandboxSpecOf(environment.applied, effectiveSandboxConfig(config).limits.idle);
    const pinned = spec === undefined ? platformTools(definition) : pin(definition, spec);
    const created: Session = {
      id,
      agentId: body.agentId,
      ownerUserId: body.ownerUserId,
      manifest: pinned.manifest ?? definition.manifest,
      manifestHash: pinned.manifestHash ?? definition.manifestHash,
      definitionHash: definition.manifestHash,
      implementationVersion: definition.implementationVersion,
      info: body.info,
      status: "idle",
      activeTurnId: null,
      creation: body,
      harness,
      ...(environment === undefined
        ? {}
        : { environmentId: environment.id, environmentVersion: environment.version }),
      ...(spec === undefined ? {} : { sandbox: spec }),
    };
    await t.put("sessions", id, created);
    if (environment !== undefined) await recordAttachment(t, id, environment.id);
    return created;
  });
}

/**
 * The manifest a session without a sandbox pins: its agents' `read_artifact` (R2b C11), when
 * one has a remote MCP server or an HTTP tool; nothing otherwise, and for a workflow.
 */
function platformTools(definition: Definition): { manifest?: AgentManifest; manifestHash?: string } {
  if (isWorkflowManifest(definition.manifest)) return {};
  const pinned = withPlatformTools(definition.manifest as AgentManifest);
  if (pinned === undefined) return {};
  if (!pinned.ok) return fail(400, pinned.message);
  return { manifest: pinned.manifest, manifestHash: pinned.manifestHash };
}

/** The manifest a session with a sandbox pins: the definition with the sandbox capability. */
function pin(
  definition: Definition,
  spec: SandboxManifest
): { manifest?: AgentManifest; manifestHash?: string } {
  // A workflow's manifest stays as registered: its agents inherit the sandbox when they start.
  if (isWorkflowManifest(definition.manifest)) return {};
  const sandboxed = withSandboxCapability(definition.manifest as AgentManifest, spec);
  if (!sandboxed.ok) return fail(400, sandboxed.message);
  return { manifest: sandboxed.manifest, manifestHash: sandboxed.manifestHash };
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
    manifestHash: s.manifestHash,
    ...(s.definitionHash === undefined ? {} : { definitionHash: s.definitionHash }),
    implementationVersion: s.implementationVersion,
    status: s.status,
    activeTurnId: s.activeTurnId,
    environment:
      s.environmentId === undefined
        ? null
        : { id: s.environmentId, version: s.environmentVersion ?? 1 },
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
