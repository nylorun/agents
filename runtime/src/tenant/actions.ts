/**
 * Sandbox tools for an Action being delivered (`POST /v1/actions/:id/sandbox/:tool`), called by
 * its Action endpoint with the delivery token, and the session and Action lookups the sandbox
 * route handlers share.
 */
import type { Action } from "@nylorun/core/contracts";
import {
  SandboxRouteError,
  handleActionSandboxTool,
  type SandboxRouteDeps,
} from "../core/sandbox-routes.js";
import { scoped } from "./auth.js";
import { sandboxLookup, sessionOf, type TenantContext } from "./context.js";
import type { DeliveryScope } from "./delivery-token.js";
import { fail } from "./http.js";

/** Session and Action lookups for the sandbox route handlers. */
export function sandboxRouteDeps(ctx: TenantContext): SandboxRouteDeps {
  return {
    sandbox: ctx.sandbox,
    session: (id) =>
      ctx.store.tx(async (t) => {
        const session = await sessionOf(t, id);
        return { session, lookup: await sandboxLookup(t, id) };
      }),
    getAction: (id) => ctx.store.tx((t) => t.get<Action>("actions", id)),
  };
}

/** `POST /v1/actions/:id/sandbox/:tool`: a sandbox tool call for the Action being delivered. */
export async function actionSandboxTool(
  ctx: TenantContext,
  scope: DeliveryScope,
  actionId: string,
  toolName: string,
  body: () => Promise<unknown>,
  signal: AbortSignal
) {
  const action =
    (await ctx.store.tx((t) => t.get<Action>("actions", actionId))) ??
    fail(404, "Action not found");
  scoped(scope, action);
  try {
    return await handleActionSandboxTool(
      sandboxRouteDeps(ctx),
      actionId,
      toolName,
      await body(),
      signal,
      { generation: scope.generation }
    );
  } catch (error) {
    if (error instanceof SandboxRouteError) fail(error.status, error.message);
    throw error;
  }
}
