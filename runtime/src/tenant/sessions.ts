/**
 * Session and definition resources: `PUT/GET /v1/agents`, `PUT /v1/sessions/:id` (create or
 * re-attach vaults), the session list and the session view. Reads use the store's typed
 * queries; `PUT /v1/sessions/:id` runs in one transaction with the vault attachment checks.
 */
import {
  DefinitionDocumentSchema,
  type PutAgentRequest,
  type PutSessionRequest,
} from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import type { AgentManifest, SandboxManifest } from "@nylorun/core/define";
import { aggregateWaits, isWorkflowManifest } from "../core/flow-host.js";
import { canonical } from "../store/canonical.js";
import type { Tx } from "../store/types.js";
import { validateSandboxAttach } from "../core/sandbox-routes.js";
import { resolveSandbox } from "../sandbox/resolve.js";
import { withSandboxCapability } from "../sandbox/session-sandbox.js";
import {
  declaredSandboxes,
  sandboxSpecOf,
  sessionSandboxSpec,
} from "../sandbox/share.js";
import { effectiveSandboxConfig, readSandboxConfig } from "../sandbox/tenant-config.js";
import { checkPlacement, requirePods } from "../sandbox/placement.js";
import { attachSandbox, recordAttachment } from "./sandboxes.js";
import {
  sandboxLookup,
  type Session,
  type SessionAccess,
  type TenantContext,
} from "./context.js";
import { fail } from "./http.js";

/** A session's creation identity: everything but the request id and vault attachments. */
const sessionIdentity = (value: any): string => {
  const {
    requestId: _requestId,
    vaultIds: _vaultIds,
    credentialSelections: _selections,
    ...body
  } = value ?? {};
  return canonical(body);
};

interface Definition {
  manifest: any;
  manifestHash: string;
  implementationVersion: string;
  pluginRoots?: Record<string, string>;
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
  const declared = declaredSandboxes(body.manifest);
  if (declared.length > 0)
    fail(
      400,
      `${declared.join(", ")} declares a sandbox. Agents no longer declare one: remove .sandbox() and open the session with it, createSession({ sandbox: { image, network: { allow }, resources } }), or set the Tenant's default sandbox. See MIGRATION.md.`
    );
  const definition = {
    ...body,
    manifestHash: hashManifest(body.manifest as any),
  };
  await ctx.store.tx((t) => t.put("definitions", agentId, definition));
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
 * Create a session from its definition, or re-attach vaults to an identical one. `owner`, when
 * the request acts for a subject, must be the session's owner: another owner's session id is
 * the 404 of a missing one (not the 409 of a mismatch), and so are another owner's vaults and
 * sandboxes.
 *
 * The session's sandbox is decided here and fixed for its life (§5 of Sandboxes v3): shared
 * with `{ session }`, none with `false`, inline, or the Tenant default when omitted. A definition
 * that declares its own sandbox (`.sandbox()`) keeps it and takes no sandbox request.
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
     * The sandboxes the caller reaches (a token caller's grants, `sandboxGrantsOf`); undefined
     * reaches every one. `sandbox: { id }` must name one of them.
     */
    sandboxGrants?: readonly string[];
  } = {}
): Promise<Session> {
  const vaultIds = body.vaultIds ?? [];
  const credentialSelections = body.credentialSelections ?? [];
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
    await ctx.vault.assertAttachment(
      t,
      body.ownerUserId,
      vaultIds,
      credentialSelections,
      { opaque }
    );
    if (prior) {
      if (sessionIdentity(prior.creation) !== sessionIdentity(body))
        fail(409, "Session already exists with different creation parameters");
      prior.vaultIds = vaultIds;
      prior.credentialSelections = credentialSelections;
      prior.creation = body;
      await t.put("sessions", id, prior);
      await ctx.vault.recordAttachment(t, id, vaultIds);
      return prior;
    }
    const definition =
      (await t.get<Definition>("definitions", body.agentId)) ??
      fail(404, "Definition not found");
    const sandbox = await sessionSandbox(t, body, definition, {
      opaque,
      ...(options.sandboxGrants === undefined ? {} : { grants: options.sandboxGrants }),
    });
    // Placement (D38): where this session's harness may run, decided now and kept.
    checkPlacement(await readSandboxConfig(t), sandbox.kind);
    if (sandbox.kind === "pod") await requirePods(ctx.pods, `Sandbox ${sandbox.sandboxId}`);
    const created: Session = {
      id,
      agentId: body.agentId,
      ownerUserId: body.ownerUserId,
      manifest: sandbox.manifest ?? definition.manifest,
      manifestHash: sandbox.manifestHash ?? definition.manifestHash,
      implementationVersion: definition.implementationVersion,
      info: body.info,
      status: "idle",
      activeTurnId: null,
      creation: body,
      vaultIds,
      credentialSelections,
      pluginRoots: definition.pluginRoots ?? {},
      ...(sandbox.sandboxOwnerId !== undefined
        ? { sandboxOwnerId: sandbox.sandboxOwnerId }
        : {}),
      ...(sandbox.sandboxId !== undefined ? { sandboxId: sandbox.sandboxId } : {}),
      ...(sandbox.spec !== undefined
        ? { sandbox: sandbox.spec, sandboxSource: sandbox.source }
        : {}),
    };
    await t.put("sessions", id, created);
    await ctx.vault.recordAttachment(t, id, vaultIds);
    if (sandbox.sandboxId !== undefined) await recordAttachment(t, id, sandbox.sandboxId);
    return created;
  });
}

function isShare(value: unknown): value is { session: string } {
  return typeof value === "object" && value !== null && "session" in value;
}

function isAttach(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && "id" in value;
}

interface SessionSandbox {
  readonly spec?: SandboxManifest;
  readonly source?: Session["sandboxSource"];
  readonly sandboxOwnerId?: string;
  /** The sandbox resource the session attaches to, and its kind. */
  readonly sandboxId?: string;
  readonly kind?: "virtual" | "pod";
  /** Set when the pinned manifest differs from the definition's. */
  readonly manifest?: AgentManifest;
  readonly manifestHash?: string;
}

/** Decide a new session's sandbox and, for an agent, the manifest that carries its tools. */
async function sessionSandbox(
  t: Tx,
  body: PutSessionRequest,
  definition: Definition,
  options: { opaque: boolean; grants?: readonly string[] }
): Promise<SessionSandbox> {
  const request = body.sandbox;
  const declared = sandboxSpecOf(definition.manifest) !== undefined;
  if (isAttach(request)) {
    if (declared)
      fail(
        400,
        `'${body.agentId}' declares its own sandbox with .sandbox(). Remove it from the agent to attach a sandbox.`
      );
    const sandbox = await attachSandbox(t, request.id, options.grants);
    // A pod's storage and lifecycle are the resource's, not the agent's sandbox manifest.
    const { storage: _storage, lifecycle: _lifecycle, ...spec } = sandbox.spec as typeof sandbox.spec & {
      storage?: unknown;
      lifecycle?: unknown;
    };
    return { ...(await pin(definition, spec, "sandbox")), sandboxId: sandbox.id, kind: sandbox.kind };
  }
  if (isShare(request)) {
    const owner = await t.get<Session>("sessions", request.session);
    if (owner?.sandboxId !== undefined && (!options.opaque || owner.ownerUserId === body.ownerUserId))
      fail(
        400,
        `Session ${request.session} is attached to sandbox ${owner.sandboxId}: open this session with sandbox: { id: "${owner.sandboxId}" }.`
      );
    const lookup = await sandboxLookup(t, request.session);
    const sandboxOwnerId = validateSandboxAttach(body, definition.manifest, lookup, {
      opaque: options.opaque,
      inherit: !declared,
    });
    if (declared || sandboxOwnerId === undefined) return { sandboxOwnerId };
    const spec = sessionSandboxSpec(lookup(request.session)!)!;
    return { ...(await pin(definition, spec, "shared")), sandboxOwnerId };
  }
  if (declared) {
    if (request !== undefined)
      fail(
        400,
        `'${body.agentId}' declares its own sandbox with .sandbox(). Remove it from the agent to choose the sandbox when opening the session, or omit sandbox here.`
      );
    return {};
  }
  const resolved = resolveSandbox({
    request,
    config: effectiveSandboxConfig(await readSandboxConfig(t)),
    actingForSubject: options.opaque,
  });
  if (resolved.kind === "none") return {};
  if (resolved.kind === "error") return fail(resolved.status, resolved.errors.join(" "));
  return pin(definition, resolved.spec, resolved.source);
}

async function pin(
  definition: Definition,
  spec: SandboxManifest,
  source: NonNullable<Session["sandboxSource"]>
): Promise<SessionSandbox> {
  // A workflow's manifest stays as registered: Action endpoints match workflow actions by its hash.
  if (isWorkflowManifest(definition.manifest)) return { spec, source };
  const sandboxed = withSandboxCapability(definition.manifest as AgentManifest, spec);
  if (!sandboxed.ok) return fail(400, sandboxed.message);
  return {
    spec,
    source,
    manifest: sandboxed.manifest,
    manifestHash: sandboxed.manifestHash,
  };
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
  const actions = await t.actionsForSession(s.id, {
    statuses: ["pending", "delivering", "uncertain"],
  });
  const uncertain = await t.effectsForSession<any>(s.id, {
    statuses: ["uncertain"],
  });
  return {
    id: s.id,
    agentId: s.agentId,
    ownerUserId: s.ownerUserId,
    manifestHash: s.manifestHash,
    implementationVersion: s.implementationVersion,
    status: s.status,
    activeTurnId: s.activeTurnId,
    vaultIds: s.vaultIds ?? [],
    credentialSelections: s.credentialSelections ?? [],
    sandboxOwnerId: s.sandboxOwnerId ?? null,
    ...(s.sandboxId === undefined ? {} : { sandboxId: s.sandboxId }),
    sandbox: s.sandbox ?? null,
    ...(s.sandboxSource ? { sandboxSource: s.sandboxSource } : {}),
    mcpSnapshot: s.mcpSnapshot ?? null,
    mcpDiagnostics: s.mcpDiagnostics ?? [],
    waits,
    error: s.error,
    actions,
    uncertainEffects: uncertain.map((e) => ({
      effectId: e.request.effectId,
      turnId: e.request.turnId,
      kind: e.request.kind,
      error: e.error,
    })),
  };
}
