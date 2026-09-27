/**
 * The Tenant HTTP router: authenticates the bearer token, matches `/v1/...` routes and
 * delegates to the service modules (commands, actions, sessions, live, routes-tenant). It
 * maps typed errors to responses and owns no business logic of its own.
 *
 * Later waves: Wave 1 / A awaits the async services; Wave 2 / Y swaps the history and SSE
 * handlers for stream readers. Route shapes do not change.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PutAgentRequestSchema,
  PutSessionRequestSchema,
  RegisterExecutorsRequestSchema,
  SessionCommandSchema,
} from "@nylorun/core/contracts";
import { VaultError } from "../vault/error.js";
import {
  SandboxRouteError,
  handleSessionSandboxTool,
} from "../core/sandbox-routes.js";
import { sessionOf, type TenantContext } from "./context.js";
import {
  HttpError,
  OpaqueAuthError,
  fail,
  readBody,
  requestAborted,
} from "./http.js";
import { authenticate, requireApplication } from "./auth.js";
import { command } from "./commands.js";
import {
  actionSandboxTool,
  deleteExecutor,
  listExecutors,
  listPendingActions,
  registerExecutors,
  sandboxRouteDeps,
  updateAction,
} from "./actions.js";
import {
  listDefinitions,
  listSessions,
  putDefinition,
  putSession,
  sessionView,
} from "./sessions.js";
import {
  readHistory,
  requestCursor,
  streamExecutorWork,
  streamSessionEvents,
} from "./live.js";
import { expireClaims } from "./scheduler.js";
import { dispatchTenant, dispatchVault } from "./routes-tenant.js";

export async function handle(
  ctx: TenantContext,
  request: IncomingMessage,
  response: ServerResponse,
  _url?: URL
): Promise<void> {
  const json = (value: unknown, status = 200) => {
    const payload = JSON.stringify(value);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  };
  try {
    const url = _url ?? new URL(request.url ?? "/", "http://runtime");
    const path = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const method = request.method;
    const scope = authenticate(ctx, request);
    if (path[0] !== "v1") fail(404, "Route not found");
    if (path[1] === "executors" && path[2] === "connect" && method === "GET") {
      if (scope.kind !== "executor")
        return fail(403, "Executor credential required");
      streamExecutorWork(ctx.live, request, response, scope.executor.tokenHash);
      return;
    }
    if (path[1] === "actions") {
      if (scope.kind !== "executor")
        return fail(403, "Executor credential required");
      expireClaims(ctx);
      if (path.length === 2 && method === "GET")
        return json(listPendingActions(ctx, scope.executor));
      const actionId = path[2];
      if (!actionId) fail(404, "Action not found");
      if (
        method === "POST" &&
        path[3] === "sandbox" &&
        path[4] &&
        path.length === 5
      )
        return json(
          await actionSandboxTool(ctx, scope, actionId!, path[4], request)
        );
      const body = await readBody(request);
      return json(updateAction(ctx, scope, actionId!, method, path[3], body));
    }
    if (
      path[1] === "sessions" &&
      path[2] &&
      path[3] === "commands" &&
      method === "POST"
    )
      return json(
        command(
          ctx,
          path[2],
          SessionCommandSchema.parse(await readBody(request)),
          scope
        )
      );
    if (path[1] === "vaults")
      return json(await dispatchVault(ctx, scope, method, path, url, request));
    if (path[1] === "tenant")
      return json(await dispatchTenant(ctx, scope, method, path, request));
    const principalId = requireApplication(scope);
    if (path[1] === "executors" && path.length === 2 && method === "GET")
      return json(listExecutors(ctx));
    // The length guard matters: the connect branch above only matches GET, so without it a
    // PUT to /v1/executors/connect would register an agent literally named "connect".
    if (path[1] === "executors" && path.length === 2 && method === "PUT")
      return json(
        registerExecutors(
          ctx,
          principalId,
          RegisterExecutorsRequestSchema.parse(await readBody(request))
        )
      );
    if (
      path[1] === "executors" &&
      path.length === 3 &&
      path[2] &&
      method === "DELETE"
    )
      return json(deleteExecutor(ctx, path[2]));
    if (path[1] === "agents" && path.length === 2 && method === "GET")
      return json(listDefinitions(ctx));
    if (path[1] === "sessions" && path.length === 2 && method === "GET")
      return json(listSessions(ctx, url.searchParams.get("agentId")));
    if (
      path[1] === "agents" &&
      path[2] &&
      path.length === 3 &&
      method === "PUT"
    )
      return json(
        putDefinition(
          ctx,
          path[2],
          PutAgentRequestSchema.parse(await readBody(request))
        )
      );
    if (path[1] === "sessions" && path[2]) {
      const id = path[2];
      if (method === "PUT" && path.length === 3)
        return json(
          sessionView(
            ctx,
            putSession(
              ctx,
              id,
              PutSessionRequestSchema.parse(await readBody(request))
            )
          )
        );
      const s = sessionOf(ctx, id);
      if (method === "GET" && path.length === 3)
        return json(sessionView(ctx, s));
      const cursor = requestCursor(request, url);
      if (method === "GET" && path[3] === "items")
        return json(
          readHistory(
            ctx,
            id,
            cursor,
            url.searchParams.get("agent") ?? undefined
          )
        );
      if (method === "GET" && path[3] === "events") {
        streamSessionEvents(ctx, request, response, id, cursor);
        return;
      }
      if (
        method === "POST" &&
        path[3] === "sandbox" &&
        path[4] &&
        path.length === 5
      ) {
        requireApplication(scope);
        try {
          const outcome = await handleSessionSandboxTool(
            sandboxRouteDeps(ctx),
            id,
            path[4],
            await readBody(request),
            requestAborted(request)
          );
          return json(outcome);
        } catch (error) {
          if (error instanceof SandboxRouteError)
            fail(error.status, error.message);
          throw error;
        }
      }
    }
    fail(404, "Route not found");
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof OpaqueAuthError) {
      json(error.body, error.status);
      return;
    }
    const status =
      error instanceof HttpError ||
      error instanceof VaultError ||
      error instanceof SandboxRouteError
        ? error.status
        : (error as any)?.name === "ZodError" ||
          (error as Error)?.message === "Invalid cursor"
        ? 400
        : 500;
    json(
      {
        status: "rejected",
        code: status === 500 ? "internal_error" : "request_rejected",
        message:
          status === 500 ? "Runtime request failed" : (error as Error).message,
      },
      status
    );
  }
}
