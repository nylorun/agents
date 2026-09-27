/**
 * Session and definition resources: `PUT/GET /v1/agents`, `PUT /v1/sessions/:id` (create or
 * re-attach vaults), the session list and the session view.
 *
 * Later waves: Wave 1 / A makes the transactions async and replaces the `store.all` scans
 * with typed queries (`listDefinitions`, `listSessions`, `actionsForSession`,
 * `effectsForSession`).
 */
import {
  DefinitionDocumentSchema,
  type Action,
  type PutAgentRequest,
  type PutSessionRequest,
} from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/compatibility";
import { aggregateWaits, isWorkflowManifest } from "../core/flow-host.js";
import { canonical } from "../core/store.js";
import { validateSandboxAttach } from "../core/sandbox-routes.js";
import type { Session, TenantContext } from "./context.js";
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

export function listDefinitions(ctx: TenantContext) {
  return {
    agents: ctx.store.all("definitions").map((d) => ({
      agentId: d.manifest.id,
      manifest: d.manifest,
      manifestHash: d.manifestHash,
      implementationVersion: d.implementationVersion,
    })),
  };
}

export function putDefinition(
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
  ctx.store.tx(() => {
    ctx.store.put("definitions", agentId, definition);
  });
  return {
    agentId,
    manifestHash: definition.manifestHash,
    implementationVersion: body.implementationVersion,
  };
}

export function listSessions(ctx: TenantContext, agentId: string | null) {
  return {
    sessions: ctx.store
      .all<Session>("sessions")
      .filter((s) => agentId === null || s.agentId === agentId)
      .map((s) => ({
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
): Session {
  const { store } = ctx;
  const vaultIds = body.vaultIds ?? [];
  const credentialSelections = body.credentialSelections ?? [];
  const prior = store.get<Session>("sessions", id);
  const definition =
    prior === undefined || body.sandbox
      ? store.get<{
          manifest: unknown;
          manifestHash: string;
          implementationVersion: string;
          pluginRoots?: Record<string, string>;
        }>("definitions", body.agentId) ?? fail(404, "Definition not found")
      : undefined;
  const sandboxOwnerId = body.sandbox
    ? validateSandboxAttach(
        body,
        (definition ?? prior)!.manifest as never,
        (sid) => store.get<Session>("sessions", sid)
      )
    : undefined;
  return store.tx(() => {
    ctx.vault.assertAttachment(
      body.ownerUserId,
      vaultIds,
      credentialSelections
    );
    const existing = store.get<Session>("sessions", id);
    if (existing) {
      if (sessionIdentity(existing.creation) !== sessionIdentity(body))
        fail(409, "Session already exists with different creation parameters");
      existing.vaultIds = vaultIds;
      existing.credentialSelections = credentialSelections;
      existing.creation = body;
      if (sandboxOwnerId !== undefined) existing.sandboxOwnerId = sandboxOwnerId;
      store.put("sessions", id, existing);
      ctx.vault.recordAttachment(id, vaultIds);
      return existing;
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
    store.put("sessions", id, created);
    ctx.vault.recordAttachment(id, vaultIds);
    return created;
  });
}

/** The session resource returned by `GET`/`PUT /v1/sessions/:id`. */
export function sessionView(ctx: TenantContext, s: Session): unknown {
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
    waits: (() => {
      if (isWorkflowManifest(s.manifest)) {
        const aggregated = aggregateWaits({
          store: ctx.store,
          workflowSessionId: s.id,
        });
        if (aggregated.length > 0) return aggregated;
      }
      return Array.isArray(s.waits)
        ? s.waits.map((call: any) => ({
            invocationId: call.invocationId,
            interaction: call.interaction,
            wait: call.wait,
            status: call.status,
          }))
        : s.waits;
    })(),
    error: s.error,
    actions: ctx.store
      .all<Action>("actions")
      .filter(
        (a) =>
          a.sessionId === s.id && !["completed", "cancelled"].includes(a.status)
      ),
    uncertainEffects: ctx.store
      .all("effects")
      .filter((e) => e.request.sessionId === s.id && e.status === "uncertain")
      .map((e) => ({
        effectId: e.request.effectId,
        turnId: e.request.turnId,
        kind: e.request.kind,
        error: e.error,
      })),
  };
}
