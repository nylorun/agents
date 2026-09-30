/**
 * The Tenant HTTP router: authenticates the bearer token, matches `/v1/...` routes and
 * delegates to the Tenant's service modules (`tenant/`: commands, actions, sessions, live),
 * `routes-tenant.ts`, `routes-access.ts` and the AG-UI and A2A endpoints (`api/ag-ui/`,
 * `api/a2a/`). It maps typed errors to responses and owns no business logic of its own.
 * History, SSE and executor work streams read Durable Streams (`tenant/live.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PutAgentRequestSchema,
  PutSessionRequestSchema,
  RegisterExecutorsRequestSchema,
  SessionCommandSchema,
} from "@nylorun/core/contracts";
import { VaultError } from "../../vault/error.js";
import {
  SandboxRouteError,
  handleSessionSandboxTool,
} from "../../core/sandbox-routes.js";
import { loadSession, sessionOf, type TenantContext } from "../../tenant/context.js";
import {
  HttpError,
  OpaqueAuthError,
  fail,
  readBody,
  requestAborted,
} from "../../tenant/http.js";
import {
  accessOf,
  authenticate,
  authorize,
  requireApplication,
  requirePrincipal,
} from "../../tenant/auth.js";
import { dispatchAccess } from "./routes-access.js";
import { identifyClient } from "../../tenant/browser.js";
import { dispatchAgUi } from "../ag-ui/routes.js";
import { command } from "../../tenant/commands.js";
import {
  actionSandboxTool,
  deleteExecutor,
  listExecutors,
  listPendingActions,
  registerExecutors,
  sandboxRouteDeps,
  updateAction,
} from "../../tenant/actions.js";
import {
  listAgentsPublic,
  listDefinitions,
  listSessions,
  putDefinition,
  putSession,
  sessionView,
} from "../../tenant/sessions.js";
import {
  readHistory,
  requestCursor,
  streamExecutorWork,
  streamSessionEvents,
} from "../../tenant/live.js";
import { dispatchTenant, dispatchVault } from "./routes-tenant.js";
import { dispatchA2a } from "../a2a/routes.js";

export async function handle(
  ctx: TenantContext,
  request: IncomingMessage,
  response: ServerResponse,
  _url?: URL
): Promise<void> {
  const json = (
    value: unknown,
    status = 200,
    headers: Readonly<Record<string, string>> = {}
  ) => {
    const payload = JSON.stringify(value);
    response.writeHead(status, {
      ...headers,
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
    // The client app first: a browser's origin is checked, and CORS headers set, before the
    // bearer is looked at, so every answer from here on is readable by an allowed page.
    const client = await identifyClient(ctx, request, response);
    const scope = await authenticate(ctx, request, client);
    if (path[0] !== "v1") fail(404, "Route not found");
    authorize(scope, method, path);
    if (scope.kind === "publishable") {
      if (path[1] === "agents" && path.length === 2 && method === "GET")
        return json(await listAgentsPublic(ctx, scope.agents));
      if (path[1] === "access")
        return json(await dispatchAccess(ctx, scope, method, path, request));
      return fail(403, "A publishable key alone reaches only the agent list", {
        code: "scope_required",
      });
    }
    // Set when the request acts for a person: only their own sessions (of the agents a token
    // allows) are reachable.
    const access = accessOf(scope);
    if (path[1] === "executors" && path[2] === "connect" && method === "GET") {
      if (scope.kind !== "executor")
        return fail(403, "Executor credential required");
      streamExecutorWork(ctx.live, request, response, scope.executor.tokenHash);
      return;
    }
    if (path[1] === "actions") {
      if (scope.kind !== "executor")
        return fail(403, "Executor credential required");
      if (path.length === 2 && method === "GET")
        return json(await listPendingActions(ctx, scope.executor));
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
      return json(
        await updateAction(ctx, scope, actionId!, method, path[3], body)
      );
    }
    if (
      path[1] === "sessions" &&
      path[2] &&
      path[3] === "commands" &&
      method === "POST"
    )
      return json(
        await command(
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
    if (path[1] === "tokens" || path[1] === "access")
      return json(await dispatchAccess(ctx, scope, method, path, request));
    // Executors reach only their own routes above.
    if (scope.kind === "executor")
      return fail(403, "Application credential required");
    if (path[1] === "ag-ui")
      return await dispatchAgUi(ctx, scope, method, path, url, request, response, json);
    if (path[1] === "a2a")
      return json(
        await dispatchA2a(ctx, scope, method, path, url, request, response)
      );
    if (path[1] === "executors" && path.length === 2 && method === "GET")
      return json(listExecutors(ctx));
    // The length guard matters: the connect branch above only matches GET, so without it a
    // PUT to /v1/executors/connect would register an agent literally named "connect".
    if (path[1] === "executors" && path.length === 2 && method === "PUT")
      return json(
        await registerExecutors(
          ctx,
          requirePrincipal(scope),
          RegisterExecutorsRequestSchema.parse(await readBody(request))
        )
      );
    if (
      path[1] === "executors" &&
      path.length === 3 &&
      path[2] &&
      method === "DELETE"
    )
      return json(await deleteExecutor(ctx, path[2]));
    if (path[1] === "agents" && path.length === 2 && method === "GET")
      return json(
        scope.kind === "token"
          ? await listAgentsPublic(ctx, scope.agents)
          : await listDefinitions(ctx)
      );
    if (path[1] === "sessions" && path.length === 2 && method === "GET")
      return json(
        await listSessions(ctx, url.searchParams.get("agentId"), access)
      );
    if (
      path[1] === "agents" &&
      path[2] &&
      path.length === 3 &&
      method === "PUT"
    )
      return json(
        await putDefinition(
          ctx,
          path[2],
          PutAgentRequestSchema.parse(await readBody(request))
        )
      );
    if (path[1] === "sessions" && path[2]) {
      const id = path[2];
      if (method === "PUT" && path.length === 3) {
        const body = PutSessionRequestSchema.parse(await readBody(request));
        // Agent code may trust `info`: only an app server sets it.
        if (scope.kind === "token" && body.info !== undefined)
          fail(403, "A subject token cannot set session info", {
            code: "scope_required",
          });
        const session = await putSession(ctx, id, body, access);
        return json(await ctx.store.tx((t) => sessionView(t, session)));
      }
      if (method === "GET" && path.length === 3)
        return json(
          await ctx.store.tx(async (t) =>
            sessionView(t, await sessionOf(t, id, access))
          )
        );
      // Every other session route needs the session to exist.
      await loadSession(ctx, id, access);
      const cursor = requestCursor(request, url);
      if (method === "GET" && path[3] === "items")
        return json(
          await readHistory(
            ctx,
            id,
            cursor,
            url.searchParams.get("agent") ?? undefined
          )
        );
      if (method === "GET" && path[3] === "events") {
        await streamSessionEvents(
          ctx,
          request,
          response,
          id,
          cursor,
          scope.kind === "token"
            ? {
                subject: scope.subject,
                epoch: scope.epoch,
                expiresAt: scope.expiresAt,
              }
            : undefined
        );
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
    const rejection = error instanceof HttpError ? error.rejection : {};
    const headers = error instanceof HttpError ? error.headers : {};
    json(
      {
        status: "rejected",
        code:
          status === 500
            ? "internal_error"
            : rejection.code ?? "request_rejected",
        message:
          status === 500 ? "Runtime request failed" : (error as Error).message,
        ...(rejection.details === undefined
          ? {}
          : { details: rejection.details }),
      },
      status,
      headers
    );
  }
}
