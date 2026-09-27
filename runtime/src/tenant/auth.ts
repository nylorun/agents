/**
 * Tenant request authentication and authorization: a bearer token resolves to an application
 * principal or a registered executor; anything else is the opaque 404 (D5).
 */
import type { IncomingMessage } from "node:http";
import type { Action } from "@nylorun/core/contracts";
import { hashToken } from "../core/executors.js";
import type { AuthScope, TenantContext } from "./context.js";
import { fail, failOpaque } from "./http.js";

export async function authenticate(
  ctx: TenantContext,
  request: IncomingMessage
): Promise<AuthScope> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !header?.startsWith("Bearer ")) {
    ctx.config.logger.warn("credential rejected", {
      reason: "missing_bearer",
    });
    return failOpaque();
  }
  const tokenHash = hashToken(token);
  const principal = await ctx.store.tx((t) => t.principalByTokenHash(tokenHash));
  if (principal) return { kind: "application", principalId: principal.id };
  const executor = ctx.registry.find(tokenHash);
  if (!executor) {
    ctx.config.logger.warn("credential rejected", {
      reason: "unknown_token",
    });
    return failOpaque();
  }
  return { kind: "executor", executor };
}

/** The executor scope must belong to the Action's agent. */
export function scoped(scope: AuthScope, action: Action): void {
  if (scope.kind !== "executor" || scope.executor.agentId !== action.agentId)
    fail(403, "Executor scope does not authorize this action");
}

export function requireApplication(scope: AuthScope): string {
  if (scope.kind === "application") return scope.principalId;
  return fail(403, "Application credential required");
}
