/**
 * The Action service and the executor registry: discover pending Actions, claim, heartbeat,
 * claim-scoped sandbox tool calls, and executor registration, listing and removal.
 *
 * Later waves: Wave 1 / A makes the transactions async, replaces the `GET /v1/actions` scan
 * with `pendingActions(agentId)` and seeds the registry asynchronously; Wave 2 / Y reads the
 * executor `connected` flag from the work stream instead of `executorStreams`.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  ActionClaimRequestSchema,
  ActionHeartbeatRequestSchema,
  type Action,
  type LiveEvent,
  type RegisterExecutorsRequestSchema,
} from "@nylorun/core/contracts";
import {
  assertExecutorCredential,
  hashToken,
  type ExecutorRecord,
} from "../core/executors.js";
import {
  SandboxRouteError,
  handleActionSandboxTool,
} from "../core/sandbox-routes.js";
import { applicationTokenHashes } from "./principals.js";
import {
  sessionOf,
  type AuthScope,
  type Session,
  type TenantContext,
} from "./context.js";
import { fail, readBody, requestAborted } from "./http.js";
import { scoped } from "./auth.js";
import { endExecutorStreams, executorConnected } from "./live.js";

type RegisterExecutorsRequest = ReturnType<
  typeof RegisterExecutorsRequestSchema.parse
>;

/** Session and Action lookups for the sandbox route handlers. */
export function sandboxRouteDeps(ctx: TenantContext) {
  return {
    sandbox: ctx.sandbox,
    session: (id: string) => sessionOf(ctx, id),
    lookup: (id: string) => ctx.store.get<Session>("sessions", id),
    getAction: (id: string) => ctx.store.get<Action>("actions", id),
  };
}

/** `GET /v1/actions`: the pending Actions of the executor's agent. */
export function listPendingActions(
  ctx: TenantContext,
  executor: ExecutorRecord
) {
  return {
    actions: ctx.store
      .all<Action>("actions")
      .filter((a) => a.status === "pending" && a.agentId === executor.agentId),
  };
}

/** `POST /v1/actions/:id/sandbox/:tool`: a claim-scoped sandbox tool call. */
export async function actionSandboxTool(
  ctx: TenantContext,
  scope: AuthScope,
  actionId: string,
  toolName: string,
  request: IncomingMessage
) {
  const action =
    ctx.store.get<Action>("actions", actionId) ??
    fail(404, "Action not found");
  scoped(scope, action);
  try {
    return await handleActionSandboxTool(
      sandboxRouteDeps(ctx),
      actionId,
      toolName,
      await readBody(request),
      requestAborted(request)
    );
  } catch (error) {
    if (error instanceof SandboxRouteError) fail(error.status, error.message);
    throw error;
  }
}

/** `POST /v1/actions/:id/claim` and `/heartbeat`; anything else under the Action is a 404. */
export function updateAction(
  ctx: TenantContext,
  scope: AuthScope,
  actionId: string,
  method: string | undefined,
  operation: string | undefined,
  body: unknown
) {
  const { store } = ctx;
  let event: LiveEvent | undefined;
  const result = store.tx(() => {
    const action =
      store.get<Action>("actions", actionId) ?? fail(404, "Action not found");
    scoped(scope, action);
    if (method === "POST" && operation === "claim") {
      ActionClaimRequestSchema.parse(body);
      if (
        action.status !== "pending" ||
        sessionOf(ctx, action.sessionId).status === "cancelled" ||
        sessionOf(ctx, action.sessionId).activeTurnId !== action.turnId
      )
        fail(409, "Action unavailable");
      action.status = "claimed";
      action.generation++;
      action.claimId = randomUUID();
      action.leaseExpiresAt = new Date(
        Date.now() + (ctx.config.leaseMs ?? 30000)
      ).toISOString();
      store.put("actions", actionId, action);
      event = store.event(action.sessionId, action.turnId, "action.claimed", {
        actionId,
        generation: action.generation,
        ...(action.agent ? { agent: action.agent } : {}),
      });
      return {
        action,
        claimId: action.claimId,
        generation: action.generation,
        leaseExpiresAt: action.leaseExpiresAt,
      };
    }
    if (method === "POST" && operation === "heartbeat") {
      const beat = ActionHeartbeatRequestSchema.parse(body);
      if (
        sessionOf(ctx, action.sessionId).activeTurnId !== action.turnId ||
        action.status !== "claimed" ||
        action.claimId !== beat.claimId ||
        action.generation !== beat.generation ||
        Date.parse(action.leaseExpiresAt!) <= Date.now()
      )
        fail(409, "Stale or expired claim");
      action.leaseExpiresAt = new Date(
        Date.now() + (ctx.config.leaseMs ?? 30000)
      ).toISOString();
      store.put("actions", actionId, action);
      return { leaseExpiresAt: action.leaseExpiresAt };
    }
    return fail(404, "Route not found");
  });
  if (event) ctx.publish(event);
  return result;
}

/** `GET /v1/executors`. */
export function listExecutors(ctx: TenantContext) {
  return {
    executors: ctx.registry.list().map((e) => ({
      agentId: e.agentId,
      implementationVersion: e.implementationVersion,
      ...(e.manifestHash === undefined ? {} : { manifestHash: e.manifestHash }),
      connected: executorConnected(ctx.live, e.tokenHash),
      updatedAt: e.updatedAt,
    })),
  };
}

/** `PUT /v1/executors`: persist the batch, then update the registry and end rotated streams. */
export function registerExecutors(
  ctx: TenantContext,
  principalId: string,
  body: RegisterExecutorsRequest
) {
  const { store, registry } = ctx;
  // Credential rules are shared with startup validation, which throws plainly; on the
  // wire a rejected registration is a bad request, not a server fault.
  const applicationHashes = applicationTokenHashes(store.db);
  try {
    for (const executor of body.executors)
      assertExecutorCredential(executor, applicationHashes);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : String(error));
  }
  if (
    new Set(body.executors.map((e) => e.agentId)).size !==
      body.executors.length ||
    new Set(body.executors.map((e) => e.token)).size !== body.executors.length
  )
    fail(400, "Executor registrations must be unique per agent and token");
  const updatedAt = new Date().toISOString();
  const records = body.executors.map((executor) => ({
    agentId: executor.agentId,
    implementationVersion: executor.implementationVersion,
    ...(executor.manifestHash === undefined
      ? {}
      : { manifestHash: executor.manifestHash }),
    tokenHash: hashToken(executor.token),
    persisted: true as const,
    updatedAt,
    principalId,
  }));
  for (const record of records) {
    const collision = registry.find(record.tokenHash);
    if (collision && collision.agentId !== record.agentId)
      fail(409, "Executor tokens must be unique");
    // A token hash may not appear in both principals and executors (D3).
    if (applicationHashes.includes(record.tokenHash))
      fail(
        400,
        "Executor tokens require independent credentials and an agent id"
      );
  }
  // Persist the whole batch first; the in-memory registry must never run ahead of SQLite.
  store.tx(() => {
    for (const record of records)
      store.putExecutor({
        agentId: record.agentId,
        tokenHash: record.tokenHash,
        implementationVersion: record.implementationVersion,
        ...(record.manifestHash === undefined
          ? {}
          : { manifestHash: record.manifestHash }),
        principalId: record.principalId,
        updatedAt,
      });
  });
  const results = records.map((record) => {
    const previous = registry.get(record.agentId);
    const { rotated, previousHash } = registry.upsert(record);
    if (rotated && previousHash) endExecutorStreams(ctx.live, previousHash);
    const replacedByDifferent =
      previous?.principalId !== undefined &&
      previous.principalId !== principalId;
    if (replacedByDifferent)
      ctx.config.logger.warn(
        "executor registration replaced by different application credential",
        {
          agentId: record.agentId,
          previousPrincipalId: previous.principalId,
        }
      );
    return {
      agentId: record.agentId,
      implementationVersion: record.implementationVersion,
      rotated,
      ...(replacedByDifferent
        ? { replacedBy: "different-credential" as const }
        : {}),
    };
  });
  return { executors: results };
}

/** `DELETE /v1/executors/:agentId`: forget the executor and end its streams. */
export function deleteExecutor(ctx: TenantContext, agentId: string) {
  const existing =
    ctx.registry.get(agentId) ?? fail(404, "Executor not found");
  ctx.store.tx(() => ctx.store.deleteExecutor(agentId));
  ctx.registry.remove(agentId);
  endExecutorStreams(ctx.live, existing.tokenHash);
  return { agentId, deleted: true };
}
