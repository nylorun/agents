/**
 * The gates service's HTTP routes (blueprint §15, P1.1): the Model Gate's IR endpoint, the Tool
 * Gate's remote MCP and delivery routes (F4.1) and HTTP tool route (R2 M3), the keys service
 * (F4.2), and the health and readiness probes. Internal, so they are not in the published OpenAPI documents. The wire
 * formats are `gates/contract.ts` and `gates/tool-contract.ts`.
 *
 * Two credentials (F5, gate trust):
 *
 * | Route | Accepts | Scope from |
 * | --- | --- | --- |
 * | `POST /nylorun/v1/model-calls`, its cancel | run token | the token |
 * | `POST /nylorun/v1/tool-calls`, its cancel; `mcp/connect`, `mcp/list`, `mcp/close`; `http-calls` | run token, or core's | the token; the body only for core's |
 * | `POST /nylorun/v1/keys/:operation` | core's | — |
 * | `POST /nylorun/v1/deliveries` | core's | — |
 *
 * Core's credential is `NYLORUN_GATES_TOKEN`, which only the runtime container holds. A run
 * token (`tenant/run-token.ts`) names one lease of one session's turn: a call under it must
 * still be the session's (`409 run_stale` otherwise); a cancel need not, since a user cancel
 * makes the token stale, but stops only its own session's call.
 */
import { createHash } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { isTenantId } from "@nylorun/core/compatibility";
import type { RuntimeModelCall } from "../../contracts.js";
import {
  MAX_MODEL_CALL_BYTES,
  MODEL_CALLS_PATH,
  ModelCallBodySchema,
  TENANT_HEADER,
  type GateErrorBody,
} from "../../gates/contract.js";
import type { ModelCallHandler } from "../../gates/handler.js";
import { InflightConflict, InflightStale, type InflightCalls } from "../../gates/inflight.js";
import type { ModelGateOutcome } from "../../gates/model-gate.js";
import type { McpHandler } from "../../gates/mcp-handler.js";
import type { ToolCalls } from "../../gates/tool-calls.js";
import type { HttpOutcome, HttpToolCall } from "../../gates/http-tool.js";
import type { Keys } from "../../keys/keys.js";
import type { McpServerRef } from "../../mcp/pool.js";
import { mountKeysRoutes } from "./keys.js";
import type { Logger } from "../../tenant/types.js";
import {
  DELIVERIES_PATH,
  DELIVERY_HEADERS,
  DeliveryBodySchema,
  HTTP_CALLS_PATH,
  HttpCallBodySchema,
  MAX_TOOL_BODY_BYTES,
  MCP_CLOSE_PATH,
  MCP_CONNECT_PATH,
  MCP_LIST_PATH,
  McpListBodySchema,
  McpServerBodySchema,
  TOOL_CALLS_PATH,
  ToolCallBodySchema,
  type DeliveryAnswer,
} from "../../gates/tool-contract.js";
import { post, type OutboundPolicy } from "../../tenant/outbound.js";
import { looksLikeToken } from "../../tenant/jwt.js";
import type { RunClaims, RunTokenVerdict } from "../../tenant/run-token.js";
import { adminKeyMatches } from "../../host/http.js";
import { canonical } from "../../store/canonical.js";

/** How the gateway checks a run token: its signature and claims, then its lease (G4). */
export interface RunTokenCheck {
  verify(raw: string): Promise<RunTokenVerdict>;
  /** Why calls under `claims` are stale, or undefined while the lease is the session's. */
  stale(claims: RunClaims): Promise<string | undefined>;
}

export interface GatesAppOptions {
  /** Core's credential (`NYLORUN_GATES_TOKEN`): keys, deliveries, MCP requests outside a run. */
  readonly token: string;
  /** Checks run tokens (F5): the credential of model calls and a session's MCP requests. */
  readonly runs: RunTokenCheck;
  /** Serves an authenticated, well-formed call. */
  readonly modelGate: ModelCallHandler;
  /** Keyed calls, which outlive their client (P1.2). */
  readonly inflight: InflightCalls;
  /** Whether the gate's dependencies answer (Postgres). */
  readonly ready: () => Promise<boolean>;
  /** Largest body read. Default `MAX_MODEL_CALL_BYTES`. */
  readonly maxBodyBytes?: number;
  /** Remote MCP servers (F4.1). Without it the MCP routes answer 404. */
  readonly mcp?: McpHandler;
  /** HTTP tool calls (R2 M3). Without it the HTTP calls route answers 404. */
  readonly http?: {
    call(tenantId: string | undefined, call: HttpToolCall, signal: AbortSignal): Promise<HttpOutcome>;
  };
  /** Keyed MCP and HTTP tool calls, which outlive their client and run once (F4.1 G3). */
  readonly toolCalls?: ToolCalls;
  /** The keys service's operations (F4.2). Without it the keys route answers 404. */
  readonly keys?: () => Promise<Keys>;
  /** Logs the keys service's requests and refused credentials. */
  readonly logger?: Logger;
  /**
   * How the gate may call Action endpoints (the gateway's own `NYLORUN_ENDPOINT_*`), for
   * deliveries (F4.1). Without it the delivery route answers 404.
   */
  readonly delivery?: OutboundPolicy;
}

/** The verified run token of a request on a run route; absent under core's credential. */
type GateEnv = { Variables: { run?: RunClaims } };

const invalid = (message: string): GateErrorBody => ({
  error: { code: "invalid_request", message },
});

const gateError = (code: GateErrorBody["error"]["code"], message: string): GateErrorBody => ({
  error: { code, message },
});

export function createGatesApp(options: GatesAppOptions): Hono<GateEnv> {
  const app = new Hono<GateEnv>();
  const maxSize = options.maxBodyBytes ?? MAX_MODEL_CALL_BYTES;
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) =>
    (await options.ready()) ? c.json({ ready: true }) : c.json({ ready: false }, 503),
  );

  const bearerOf = (c: Context) => /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  const unauthorized = (c: Context, message: string) =>
    c.json(gateError("gate_unauthorized", message), 401);

  /** Core's credential, compared in constant time. */
  const core: MiddlewareHandler<GateEnv> = async (c, next) => {
    if (!adminKeyMatches(bearerOf(c), options.token))
      return unauthorized(c, "Missing or wrong credential: this route takes core's (NYLORUN_GATES_TOKEN)");
    await next();
  };

  /**
   * A run token, verified and put on the context; with `live`, its lease must still be the
   * session's. With `orCore`, core's credential is accepted instead, and the route reads the
   * session from the body.
   */
  const run =
    (accept: { live: boolean; orCore?: boolean }): MiddlewareHandler<GateEnv> =>
    async (c, next) => {
      const presented = bearerOf(c);
      // Core's credential is never JWT-shaped; a run token always is.
      if (accept.orCore && presented !== undefined && !looksLikeToken(presented)) return core(c, next);
      if (presented === undefined || !looksLikeToken(presented))
        return unauthorized(c, "Missing or wrong credential: this route takes a run token");
      const verdict = await options.runs.verify(presented);
      if (!verdict.ok) {
        logger.warn("gate_credential_refused", { route: c.req.path, reason: verdict.reason });
        return unauthorized(c, "The run token is malformed, expired, revoked or not this Tenant's");
      }
      if (accept.live) {
        const stale = await options.runs.stale(verdict.claims);
        if (stale) {
          logger.warn("gate_run_stale", {
            route: c.req.path,
            session: verdict.claims.sessionId,
            epoch: verdict.claims.epoch,
            reason: stale,
          });
          return c.json(gateError("run_stale", `The run token's lease is over: ${stale}`), 409);
        }
      }
      c.set("run", verdict.claims);
      await next();
    };

  /**
   * The Tenant a request is for: a run token's, which a `Nylorun-Tenant` header must then
   * name; else the header's, when it is a Tenant id. `false` for a bad header.
   */
  const tenantOf = (c: Context<GateEnv>): string | undefined | false => {
    const tenantId = c.req.header(TENANT_HEADER);
    const claims = c.get("run");
    if (tenantId !== undefined && (!isTenantId(tenantId) || (claims && tenantId !== claims.tenantId)))
      return false;
    return claims?.tenantId ?? tenantId;
  };
  const badTenant = (c: Context) =>
    c.json(invalid(`The ${TENANT_HEADER} header must name a Tenant, the run token's when there is one`), 400);
  const toolBodies = bodyLimit({
    maxSize: MAX_TOOL_BODY_BYTES,
    onError: (c) => c.json(invalid(`A request body may be at most ${MAX_TOOL_BODY_BYTES} bytes`), 400),
  });
  /** The parsed body, or the 400 to answer. */
  async function read<S extends z.ZodType>(
    c: Context<GateEnv>,
    schema: S,
  ): Promise<{ ok: true; tenantId: string | undefined; body: z.infer<S> } | { ok: false; response: Response }> {
    const tenantId = tenantOf(c);
    if (tenantId === false) return { ok: false, response: badTenant(c) };
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false, response: c.json(invalid("The body must be JSON"), 400) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        response: c.json(invalid(`Invalid request: ${parsed.error.issues[0]?.message ?? "malformed"}`), 400),
      };
    return { ok: true, tenantId, body: parsed.data };
  }

  /**
   * The MCP server or HTTP tool a request names, in its session: a run token's session (a body
   * naming another is refused), or, under core's credential, the body's.
   */
  function sessionOf<T extends { sessionId?: string | undefined }>(
    c: Context<GateEnv>,
    ref: T,
    field: string,
  ): { ok: true; ref: T & { sessionId: string } } | { ok: false; response: Response } {
    const claims = c.get("run");
    if (claims) {
      if (ref.sessionId !== undefined && ref.sessionId !== claims.sessionId)
        return {
          ok: false,
          response: c.json(gateError("gate_forbidden", "The run token is for another session"), 403),
        };
      return { ok: true, ref: { ...ref, sessionId: claims.sessionId } };
    }
    if (ref.sessionId === undefined)
      return {
        ok: false,
        response: c.json(invalid(`${field}.sessionId is required with core's credential`), 400),
      };
    return { ok: true, ref: ref as T & { sessionId: string } };
  }

  const serverOf = (
    c: Context<GateEnv>,
    server: Omit<McpServerRef, "sessionId"> & { sessionId?: string | undefined },
  ): { ok: true; server: McpServerRef } | { ok: false; response: Response } => {
    const scoped = sessionOf(c, server, "server");
    return scoped.ok ? { ok: true, server: scoped.ref } : scoped;
  };

  /** The run a keyed call belongs to, for the in-flight map (G4). */
  const ownerOf = (c: Context<GateEnv>) => {
    const claims = c.get("run");
    return claims ? { sessionId: claims.sessionId, epoch: claims.epoch } : undefined;
  };

  /** 409 for a keyed re-send the in-flight map refused, or undefined. */
  const refusedJoin = (c: Context, error: unknown): Response | undefined => {
    if (error instanceof InflightStale) return c.json(gateError("run_stale", error.message), 409);
    if (error instanceof InflightConflict) return c.json(gateError("gate_conflict", error.message), 409);
    return undefined;
  };

  if (options.keys)
    mountKeysRoutes(app, {
      authorized: core,
      keys: options.keys,
      logger,
    });

  const mcp = options.mcp;
  const toolCalls = options.toolCalls;
  if (mcp) {
    const scoped = run({ live: true, orCore: true });
    app.post(MCP_CONNECT_PATH, scoped, toolBodies, async (c) => {
      const request = await read(c, McpServerBodySchema);
      if (!request.ok) return request.response;
      const server = serverOf(c, request.body.server);
      if (!server.ok) return server.response;
      return c.json(await mcp.connect(request.tenantId, server.server));
    });
    app.post(MCP_LIST_PATH, scoped, toolBodies, async (c) => {
      const request = await read(c, McpListBodySchema);
      if (!request.ok) return request.response;
      const server = serverOf(c, request.body.server);
      if (!server.ok) return server.response;
      return c.json(await mcp.list(request.tenantId, server.server, request.body.cursor, c.req.raw.signal));
    });
    // Closing a session's own connection needs no live lease: the gate reopens it on demand.
    app.post(MCP_CLOSE_PATH, run({ live: false, orCore: true }), toolBodies, async (c) => {
      const request = await read(c, McpServerBodySchema);
      if (!request.ok) return request.response;
      const server = serverOf(c, request.body.server);
      if (!server.ok) return server.response;
      await mcp.close(server.server);
      return c.body(null, 204);
    });
    app.post(TOOL_CALLS_PATH, scoped, toolBodies, async (c) => {
      const request = await read(c, ToolCallBodySchema);
      if (!request.ok) return request.response;
      const server = serverOf(c, request.body.server);
      if (!server.ok) return server.response;
      const body = { ...request.body, server: server.server };
      const signal = c.req.raw.signal;
      const key = c.req.header("idempotency-key");
      try {
        // Keyed: the call runs under its own signal, once, and outlives this request (G3). The
        // hash covers the session, so a re-send joins only its own session's call.
        const answer =
          key && toolCalls
            ? await untilAborted(
                toolCalls.run(
                  request.tenantId,
                  key,
                  createHash("sha256").update(canonical(body)).digest("hex"),
                  (own) => mcp.call(request.tenantId, body, own),
                  ownerOf(c),
                ),
                signal,
              )
            : await mcp.call(request.tenantId, body, signal);
        if (signal.aborted) return new Response(null, { status: 499 });
        return c.json(answer);
      } catch (error) {
        const refused = refusedJoin(c, error);
        if (refused) return refused;
        if (signal.aborted) return new Response(null, { status: 499 });
        throw error;
      }
    });
  }

  const http = options.http;
  if (http) {
    app.post(HTTP_CALLS_PATH, run({ live: true, orCore: true }), toolBodies, async (c) => {
      const request = await read(c, HttpCallBodySchema);
      if (!request.ok) return request.response;
      const tool = sessionOf(c, request.body.tool, "tool");
      if (!tool.ok) return tool.response;
      // A run token's turn is the call's: it names the request's `Nylorun-Turn-Id`.
      const call: HttpToolCall = {
        ...request.body,
        tool: tool.ref,
        turnId: c.get("run")?.turnId ?? request.body.turnId,
      };
      const signal = c.req.raw.signal;
      const key = c.req.header("idempotency-key");
      try {
        // Keyed: runs once under its own signal and outlives this request, as an MCP call.
        const answer =
          key && toolCalls
            ? await untilAborted(
                toolCalls.run(
                  request.tenantId,
                  key,
                  createHash("sha256").update(canonical(call)).digest("hex"),
                  async (own) => ({ ok: true, result: await http.call(request.tenantId, call, own) }),
                  ownerOf(c),
                ),
                signal,
              )
            : { ok: true as const, result: await http.call(request.tenantId, call, signal) };
        if (signal.aborted) return new Response(null, { status: 499 });
        return c.json(answer);
      } catch (error) {
        const refused = refusedJoin(c, error);
        if (refused) return refused;
        if (signal.aborted) return new Response(null, { status: 499 });
        throw error;
      }
    });
  }

  if (mcp || http)
    app.post(`${TOOL_CALLS_PATH}/:key/cancel`, run({ live: false, orCore: true }), (c) => {
      if (tenantOf(c) === false) return badTenant(c);
      const owner = ownerOf(c);
      if (toolCalls && !toolCalls.cancel(c.req.param("key"), owner?.sessionId))
        return c.json(gateError("gate_forbidden", "The call is another session's"), 403);
      return c.body(null, 204);
    });

  const policy = options.delivery;
  if (policy) {
    app.post(DELIVERIES_PATH, core, toolBodies, async (c) => {
      const request = await read(c, DeliveryBodySchema);
      if (!request.ok) return request.response;
      const { url, body, headers, timeoutMs } = request.body;
      const forwarded: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (!DELIVERY_HEADERS.has(name.toLowerCase()))
          return c.json(invalid(`A delivery may not carry the header ${name}`), 400);
        forwarded[name] = value;
      }
      const signal = c.req.raw.signal;
      const result = await post(url, body, forwarded, {
        policy,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (signal.aborted) return new Response(null, { status: 499 });
      const answer: DeliveryAnswer = {
        result:
          result.kind === "response"
            ? {
                kind: "response",
                status: result.status,
                headers: result.headers,
                body: result.body.toString("base64"),
              }
            : result,
      };
      return c.json(answer);
    });
  }

  app.post(`${MODEL_CALLS_PATH}/:key/cancel`, run({ live: false }), (c) => {
    // Optional, as on a call: the gate serves one Tenant, so the key alone names the call.
    if (tenantOf(c) === false) return badTenant(c);
    if (!options.inflight.cancel(c.req.param("key"), c.get("run")!.sessionId))
      return c.json(gateError("gate_forbidden", "The call is another session's"), 403);
    return c.body(null, 204);
  });

  app.post(
    MODEL_CALLS_PATH,
    run({ live: true }),
    bodyLimit({
      maxSize,
      onError: (c) =>
        c.json(invalid(`A model call body may be at most ${maxSize} bytes`), 400),
    }),
    async (c) => {
      // Optional: the gate serves its database's one Tenant, and refuses a call naming another.
      const tenantId = tenantOf(c);
      if (tenantId === false) return badTenant(c);
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(invalid("The body must be JSON"), 400);
      }
      const parsed = ModelCallBodySchema.safeParse(raw);
      if (!parsed.success)
        return c.json(invalid(`Invalid model call: ${parsed.error.issues[0]?.message ?? "malformed"}`), 400);
      // Session, turn and agent come from the run token, never the body: they scope the
      // ledger rows and the turn and agent caps.
      const claims = c.get("run")!;
      const scope = { sessionId: claims.sessionId, turnId: claims.turnId, agentId: claims.agentId };
      const { call, ...ids } = parsed.data;
      const request = {
        ...(tenantId === undefined ? {} : { tenantId }),
        ...scope,
        ...ids,
        call: call as unknown as RuntimeModelCall,
      };
      const signal = c.req.raw.signal;
      const key = c.req.header("idempotency-key");
      try {
        let outcome: ModelGateOutcome;
        if (key) {
          // Keyed: the call runs under its own signal and outlives this request (P1.2). The
          // gate serves one Tenant, so the effect id alone is the key. The hash covers the
          // token's scope, so the new owner's re-send after a takeover hashes the same.
          const hash = createHash("sha256").update(canonical({ ...scope, ...parsed.data })).digest("hex");
          outcome = await untilAborted(
            options.inflight.run(key, hash, (own) => options.modelGate.call(request, own), ownerOf(c)),
            signal,
          );
        } else outcome = await options.modelGate.call(request, signal);
        return c.json({ outcome });
      } catch (error) {
        const refused = refusedJoin(c, error);
        if (refused) return refused;
        // The caller went away (or cancelled): nobody reads the answer.
        if (signal.aborted) return new Response(null, { status: 499 });
        throw error;
      }
    },
  );
  return app;
}

/** `promise`, or a rejection as soon as `signal` aborts (the call itself keeps running). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
