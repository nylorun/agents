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
import { aggregateWaits, isWorkflowManifest } from "../core/flow-host.js";
import { canonical } from "../store/canonical.js";
import type { Tx } from "../store/types.js";
import { validateSandboxAttach } from "../core/sandbox-routes.js";
import { sandboxLookup, type Session, type TenantContext } from "./context.js";
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

export async function putDefinition(
  ctx: TenantContext,
  agentId: string,
  body: PutAgentRequest
) {
  if (body.manifest.id !== agentId) fail(400, "Agent id mismatch");
  DefinitionDocumentSchema.parse(body.manifest);
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

export async function listSessions(ctx: TenantContext, agentId: string | null) {
  const sessions = await ctx.store.tx((t) =>
    t.listSessions<Session>(agentId === null ? {} : { agentId })
  );
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      agentId: s.agentId,
      ownerUserId: s.ownerUserId,
      status: s.status,
      activeTurnId: s.activeTurnId,
    })),
  };
}

/** Create a session from its definition, or re-attach vaults to an identical one. */
export function putSession(
  ctx: TenantContext,
  id: string,
  body: PutSessionRequest
): Promise<Session> {
  const vaultIds = body.vaultIds ?? [];
  const credentialSelections = body.credentialSelections ?? [];
  return ctx.store.tx(async (t) => {
    const prior = await t.lockSession<Session>(id);
    const definition =
      prior === undefined || body.sandbox
        ? (await t.get<Definition>("definitions", body.agentId)) ??
          fail(404, "Definition not found")
        : undefined;
    const sandboxOwnerId = body.sandbox
      ? validateSandboxAttach(
          body,
          (definition ?? prior)!.manifest as never,
          await sandboxLookup(t, body.sandbox.session)
        )
      : undefined;
    await ctx.vault.assertAttachment(
      t,
      body.ownerUserId,
      vaultIds,
      credentialSelections
    );
    if (prior) {
      if (sessionIdentity(prior.creation) !== sessionIdentity(body))
        fail(409, "Session already exists with different creation parameters");
      prior.vaultIds = vaultIds;
      prior.credentialSelections = credentialSelections;
      prior.creation = body;
      if (sandboxOwnerId !== undefined) prior.sandboxOwnerId = sandboxOwnerId;
      await t.put("sessions", id, prior);
      await ctx.vault.recordAttachment(t, id, vaultIds);
      return prior;
    }
    const created: Session = {
      id,
      agentId: body.agentId,
      ownerUserId: body.ownerUserId,
      manifest: definition!.manifest,
      manifestHash: definition!.manifestHash,
      implementationVersion: definition!.implementationVersion,
      info: body.info,
      status: "idle",
      activeTurnId: null,
      creation: body,
      vaultIds,
      credentialSelections,
      pluginRoots: definition!.pluginRoots ?? {},
      ...(sandboxOwnerId !== undefined ? { sandboxOwnerId } : {}),
    };
    await t.put("sessions", id, created);
    await ctx.vault.recordAttachment(t, id, vaultIds);
    return created;
  });
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
    statuses: ["pending", "claimed", "uncertain"],
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
