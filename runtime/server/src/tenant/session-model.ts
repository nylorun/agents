/**
 * A session's own model (Host feature `session-model`): one of a connected provider's models,
 * which the session's turns use in place of the Tenant's. It is kept on the session
 * (`Session.model`): the Model Gate reads it at each call (`HostModelVault.readHostModel`) and a
 * turn's start describes it (`turn.start.model`). The Tenant's model, and every other session's,
 * stay as they are. While its provider is disconnected the session uses the Tenant's model again.
 *
 * What its turns call, and why, is kept too (`Session.modelRecord`, `SessionModelRecord`): set when
 * the session opens (the manifest's model, or the Tenant's and why), when it chooses or clears its
 * model, and again at each segment's start, when a provider was connected or disconnected or the
 * Tenant's model changed. Each change writes `session.model`.
 */
import {
  agentModelChoice,
  type SessionModelChoice,
  type SessionModelRecord,
  type SessionModelView,
} from "@nylorun/core/contracts";
import type { Tx } from "../store/types.js";
import { canonical } from "../store/canonical.js";
import { catalogModel, hostModelCatalog } from "../model/catalog.js";
import { activeHostCredentialRow, hostCredentialRowFor, modelBinding } from "../vault/service.js";
import { takesMessages } from "./commands.js";
import { lockedSession, sessionOf, type Session, type SessionAccess, type TenantContext } from "./context.js";
import { fail } from "./http.js";

/** The model the session's next turn uses, and where it comes from. */
export async function readSessionModel(
  ctx: TenantContext,
  id: string,
  access: SessionAccess | undefined,
): Promise<SessionModelView> {
  const session = await ctx.store.tx((t) => sessionOf(t, id, access));
  return ctx.vault.getSessionModel(session.model);
}

/**
 * Chooses the session's own model, or clears it (`choice` undefined) so its turns use the
 * Tenant's. A turn calls one model: the choice changes only while no turn runs or waits.
 */
export async function chooseSessionModel(
  ctx: TenantContext,
  id: string,
  choice: SessionModelChoice | undefined,
  access: SessionAccess | undefined,
): Promise<SessionModelView> {
  const session = await ctx.store.tx(async (t) => {
    const s = await lockedSession(t, id, access);
    if (!takesMessages(s))
      fail(409, "The session's turn is running or waits: choose its model when the turn ends", {
        code: "session_busy",
      });
    if (choice) await checkChoice(t, choice);
    const { model: _model, modelSource: _source, ...rest } = s;
    const next: Session = choice ? { ...rest, model: { provider: choice.provider, model: choice.model } } : rest;
    await noteSessionModel(t, next, await sessionModelRecordOf(t, next));
    await t.put("sessions", id, next);
    return next;
  });
  return ctx.vault.getSessionModel(session.model);
}

/** Why a session's turns call the Tenant's model in place of the one asked for, and that one. */
export interface ModelFallback {
  readonly reason: NonNullable<SessionModelRecord["reason"]>;
  readonly requested: NonNullable<SessionModelRecord["requested"]>;
}

/**
 * The model a new session starts with (Host feature `agent-model`): the one its version's
 * `harness.model` names, as `chooseSessionModel` would take it (`choice`), or, when it names one
 * the Tenant cannot use now (a provider not connected, a model its catalog does not list), why
 * (`fallback`), so the Tenant's model applies. Undefined when it names none. Never fails the
 * session.
 */
export async function agentModelOf(
  t: Tx,
  harness: { readonly model?: unknown },
): Promise<{ choice: SessionModelChoice } | { fallback: ModelFallback } | undefined> {
  if (typeof harness.model !== "string") return undefined;
  const choice = agentModelChoice(harness.model);
  if (!choice) return undefined;
  const issue = await choiceIssue(t, choice);
  return issue === undefined
    ? { choice }
    : { fallback: { reason: issue.reason, requested: { ...choice, by: "manifest" } } };
}

/**
 * The model session `s`'s turns call now, and why (`SessionModelRecord`, as the Model Gate picks
 * it: `hostCredentialRowOf`): its own model while its provider is connected (`source` `manifest`
 * when its Agent's version named it, else `session`), else the Tenant's, with the reason when it
 * falls back. `fallback` is why the session opened without the model its manifest names; kept
 * from the session's record otherwise, until it chooses or clears a model. Undefined while the
 * Tenant has no model to fall back to.
 */
export async function sessionModelRecordOf(
  t: Tx,
  s: Pick<Session, "model" | "modelSource" | "modelRecord">,
  fallback?: ModelFallback,
): Promise<SessionModelRecord | undefined> {
  if (s.model) {
    const by = s.modelSource ?? "session";
    if (await hostCredentialRowFor(t, s.model.provider))
      return { provider: s.model.provider, model: s.model.model, source: by };
    return tenantModelRecord(t, { reason: "provider_not_connected", requested: { ...s.model, by } });
  }
  const kept =
    fallback ??
    (s.modelRecord?.reason !== undefined && s.modelRecord.requested?.by === "manifest"
      ? { reason: s.modelRecord.reason, requested: s.modelRecord.requested }
      : undefined);
  return tenantModelRecord(t, kept);
}

async function tenantModelRecord(t: Tx, fallback: ModelFallback | undefined): Promise<SessionModelRecord | undefined> {
  const row = await activeHostCredentialRow(t);
  if (!row) return undefined;
  const binding = modelBinding(row);
  return {
    provider: binding.provider,
    model: binding.model,
    source: "tenant",
    ...(fallback === undefined ? {} : { reason: fallback.reason, requested: { ...fallback.requested } }),
  };
}

/**
 * Keeps `record` as session `s`'s model record (the caller saves `s`) and, when it differs from
 * the one it had, writes `session.model` with the one before. Returns whether it changed.
 */
export async function noteSessionModel(t: Tx, s: Session, record: SessionModelRecord | undefined): Promise<boolean> {
  if (canonical(record ?? null) === canonical(s.modelRecord ?? null)) return false;
  const previous = s.modelRecord;
  if (record === undefined) {
    delete s.modelRecord;
    return true;
  }
  s.modelRecord = record;
  await t.event(s.id, s.activeTurnId, "session.model", { ...record, ...(previous ? { previous } : {}) });
  return true;
}

/** A choice names a connected provider and, when its catalog lists models, one of them. */
async function checkChoice(t: Tx, choice: SessionModelChoice): Promise<void> {
  const issue = await choiceIssue(t, choice);
  if (issue) fail(issue.status, issue.message, { code: issue.code });
}

/** Why `choice` is not one the Tenant can use now; undefined when it is. */
async function choiceIssue(
  t: Tx,
  choice: SessionModelChoice,
): Promise<{ status: 400 | 422; message: string; code: string; reason: ModelFallback["reason"] } | undefined> {
  if (!/^[a-zA-Z0-9._-]+$/.test(choice.provider))
    return { status: 400, message: "Invalid provider id", code: "invalid_request", reason: "invalid_model" };
  const row = await hostCredentialRowFor(t, choice.provider);
  if (!row)
    return {
      status: 422,
      message: `Model provider ${choice.provider} is not connected: connect it in Model Settings first`,
      code: "request_rejected",
      reason: "provider_not_connected",
    };
  // A custom endpoint serves the models it names; the provider's own model is always one.
  if (choice.provider === "custom" || modelBinding(row).model === choice.model) return undefined;
  const listed = hostModelCatalog().providers.find((provider) => provider.id === choice.provider);
  if (listed && listed.models.length > 0 && !catalogModel(choice.provider, choice.model))
    return {
      status: 422,
      message: `Unknown model ${choice.model} for provider ${choice.provider}`,
      code: "request_rejected",
      reason: "not_in_catalog",
    };
  return undefined;
}
