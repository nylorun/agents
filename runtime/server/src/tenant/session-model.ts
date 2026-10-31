/**
 * A session's own model (Host feature `session-model`): one of a connected provider's models,
 * which the session's turns use in place of the Tenant's. It is kept on the session
 * (`Session.model`): the Model Gate reads it at each call (`HostModelVault.readHostModel`) and a
 * turn's start describes it (`turn.start.model`). The Tenant's model, and every other session's,
 * stay as they are. While its provider is disconnected the session uses the Tenant's model again.
 */
import { agentModelChoice, type SessionModelChoice, type SessionModelView } from "@nylorun/core/contracts";
import type { Tx } from "../store/types.js";
import { catalogModel, hostModelCatalog } from "../model/catalog.js";
import { hostCredentialRowFor, modelBinding } from "../vault/service.js";
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
    const { model: _model, ...rest } = s;
    const next: Session = choice ? { ...rest, model: { provider: choice.provider, model: choice.model } } : rest;
    await t.put("sessions", id, next);
    return next;
  });
  return ctx.vault.getSessionModel(session.model);
}

/**
 * The model a new session starts with (Host feature `agent-model`): the one its version's
 * `harness.model` names, as `chooseSessionModel` would take it, or undefined when it names none or
 * one the Tenant cannot use now (a provider not connected, a model its catalog does not list), so
 * the Tenant's model applies. Never fails the session.
 */
export async function agentModelOf(t: Tx, harness: { readonly model?: unknown }): Promise<SessionModelChoice | undefined> {
  if (typeof harness.model !== "string") return undefined;
  const choice = agentModelChoice(harness.model);
  return choice && (await choiceIssue(t, choice)) === undefined ? choice : undefined;
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
): Promise<{ status: 400 | 422; message: string; code: string } | undefined> {
  if (!/^[a-zA-Z0-9._-]+$/.test(choice.provider))
    return { status: 400, message: "Invalid provider id", code: "invalid_request" };
  const row = await hostCredentialRowFor(t, choice.provider);
  if (!row)
    return {
      status: 422,
      message: `Model provider ${choice.provider} is not connected: connect it in Model Settings first`,
      code: "request_rejected",
    };
  // A custom endpoint serves the models it names; the provider's own model is always one.
  if (choice.provider === "custom" || modelBinding(row).model === choice.model) return undefined;
  const listed = hostModelCatalog().providers.find((provider) => provider.id === choice.provider);
  if (listed && listed.models.length > 0 && !catalogModel(choice.provider, choice.model))
    return { status: 422, message: `Unknown model ${choice.model} for provider ${choice.provider}`, code: "request_rejected" };
  return undefined;
}
