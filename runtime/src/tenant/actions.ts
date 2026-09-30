/**
 * The Action service and the executor registry: discover pending Actions, claim, heartbeat,
 * claim-scoped sandbox tool calls, and executor registration, listing and removal.
 *
 * A claim or heartbeat locks the Action's session and commits in one transaction; the
 * registry is updated only after the executors table commits.
 *
 * Later waves: Wave 2 / Y reads the executor `connected` flag from the work stream instead
 * of `executorStreams`.
 */
import { randomUUID } from "node:crypto";
import {
  ActionClaimRequestSchema,
  ActionHeartbeatRequestSchema,
  type Action,
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
  type SandboxRouteDeps,
} from "../core/sandbox-routes.js";
import { sessionHasSandbox } from "../sandbox/share.js";
import {
  lockedSession,
  sandboxLookup,
  sessionOf,
  type AuthScope,
  type TenantContext,
} from "./context.js";
import { fail } from "./http.js";
import { scoped } from "./auth.js";
import { endExecutorStreams, executorConnected } from "./live.js";

type RegisterExecutorsRequest = ReturnType<
  typeof RegisterExecutorsRequestSchema.parse
>;

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

/** `GET /v1/actions`: the pending Actions of the executor's agent. */
export async function listPendingActions(
  ctx: TenantContext,
  executor: ExecutorRecord
) {
  return {
    actions: await ctx.store.tx((t) => t.pendingActions(executor.agentId)),
  };
}

/**
 * `POST /v1/actions/:id/sandbox/:tool`: a claim-scoped sandbox tool call. The body is read
 * once the Action is known to be the caller's; `signal` aborts when the caller leaves.
 */
export async function actionSandboxTool(
  ctx: TenantContext,
  scope: AuthScope,
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
      signal
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
): Promise<unknown> {
  return ctx.store.tx(async (t) => {
    const found =
      (await t.get<Action>("actions", actionId)) ??
      fail(404, "Action not found");
    scoped(scope, found);
    const s = await lockedSession(t, found.sessionId);
    // Read again under the session lock.
    const action =
      (await t.get<Action>("actions", actionId)) ??
      fail(404, "Action not found");
    if (method === "POST" && operation === "claim") {
      ActionClaimRequestSchema.parse(body);
      if (
        action.status !== "pending" ||
        s.status === "cancelled" ||
        s.activeTurnId !== action.turnId
      )
        fail(409, "Action unavailable");
      action.status = "claimed";
      action.generation++;
      action.claimId = randomUUID();
      action.leaseExpiresAt = new Date(
        Date.now() + (ctx.config.leaseMs ?? 30000)
      ).toISOString();
      await t.put("actions", actionId, action);
      await t.event(action.sessionId, action.turnId, "action.claimed", {
        actionId,
        generation: action.generation,
        ...(action.agent ? { agent: action.agent } : {}),
      });
      return {
        action,
        claimId: action.claimId,
        generation: action.generation,
        leaseExpiresAt: action.leaseExpiresAt,
        sandbox: sessionHasSandbox(s, await sandboxLookup(t, s.sandboxOwnerId)),
      };
    }
    if (method === "POST" && operation === "heartbeat") {
      const beat = ActionHeartbeatRequestSchema.parse(body);
      if (
        s.activeTurnId !== action.turnId ||
        action.status !== "claimed" ||
        action.claimId !== beat.claimId ||
        action.generation !== beat.generation ||
        Date.parse(action.leaseExpiresAt!) <= Date.now()
      )
        fail(409, "Stale or expired claim");
      action.leaseExpiresAt = new Date(
        Date.now() + (ctx.config.leaseMs ?? 30000)
      ).toISOString();
      await t.put("actions", actionId, action);
      return { leaseExpiresAt: action.leaseExpiresAt };
    }
    return fail(404, "Route not found");
  });
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
export async function registerExecutors(
  ctx: TenantContext,
  principalId: string,
  body: RegisterExecutorsRequest
) {
  const { store, registry } = ctx;
  // Credential rules are shared with startup validation, which throws plainly; on the
  // wire a rejected registration is a bad request, not a server fault.
  const applicationHashes = await store.tx((t) => t.applicationTokenHashes());
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
  // Persist the whole batch first; the in-memory registry must never run ahead of the store.
  await store.tx(async (t) => {
    // An agent is served by an Action endpoint or an executor, never both.
    for (const record of records)
      if (await t.getEndpoint(record.agentId))
        fail(
          409,
          `Agent '${record.agentId}' is served by an Action endpoint; remove it first (DELETE /v1/endpoints/${record.agentId})`,
        );
    for (const record of records)
      await t.putExecutor({
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
export async function deleteExecutor(ctx: TenantContext, agentId: string) {
  const existing =
    ctx.registry.get(agentId) ?? fail(404, "Executor not found");
  await ctx.store.tx((t) => t.deleteExecutor(agentId));
  ctx.registry.remove(agentId);
  endExecutorStreams(ctx.live, existing.tokenHash);
  return { agentId, deleted: true };
}
