/**
 * The gates service's HTTP routes (blueprint §15, P1.1): the Model Gate's IR endpoint, the Tool
 * Gate's remote MCP and delivery routes (F4.1), and the health and readiness probes. Internal:
 * only the loop calls them, with the stack's gates token, so they are not in the published
 * OpenAPI documents. The wire formats are `gates/contract.ts` and `gates/tool-contract.ts`.
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
import { InflightConflict, type InflightCalls } from "../../gates/inflight.js";
import type { ModelGateOutcome } from "../../gates/model-gate.js";
import type { McpHandler } from "../../gates/mcp-handler.js";
import type { ToolCalls } from "../../gates/tool-calls.js";
import type { Keys } from "../../keys/keys.js";
import { mountKeysRoutes } from "./keys.js";
import type { Logger } from "../../tenant/types.js";
import {
  DELIVERIES_PATH,
  DELIVERY_HEADERS,
  DeliveryBodySchema,
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
import { adminKeyMatches } from "../../host/http.js";
import { canonical } from "../../store/canonical.js";

export interface GatesAppOptions {
  /** The bearer every model call must present (`NYLORUN_GATES_TOKEN`). */
  readonly token: string;
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
  /** Keyed MCP calls, which outlive their client and run once (F4.1 G3). Needs `mcp`. */
  readonly toolCalls?: ToolCalls;
  /** The keys service's operations (F4.2). Without it the keys route answers 404. */
  readonly keys?: () => Promise<Keys>;
  /** Logs the keys service's requests. */
  readonly logger?: Logger;
  /**
   * How the gate may call Action endpoints (the gateway's own `NYLORUN_ENDPOINT_*`), for
   * deliveries (F4.1). Without it the delivery route answers 404.
   */
  readonly delivery?: OutboundPolicy;
}

const invalid = (message: string): GateErrorBody => ({
  error: { code: "invalid_request", message },
});

export function createGatesApp(options: GatesAppOptions): Hono {
  const app = new Hono();
  const maxSize = options.maxBodyBytes ?? MAX_MODEL_CALL_BYTES;

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) =>
    (await options.ready()) ? c.json({ ready: true }) : c.json({ ready: false }, 503),
  );

  const authorized: MiddlewareHandler = async (c, next) => {
    const presented = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!adminKeyMatches(presented, options.token)) {
      const body: GateErrorBody = {
        error: {
          code: "gate_unauthorized",
          message: "Missing or wrong gates token; the caller and the gateway must share NYLORUN_GATES_TOKEN",
        },
      };
      return c.json(body, 401);
    }
    await next();
  };

  const tenantOf = (c: Context): string | undefined | false => {
    const tenantId = c.req.header(TENANT_HEADER);
    return tenantId !== undefined && !isTenantId(tenantId) ? false : tenantId;
  };
  const toolBodies = bodyLimit({
    maxSize: MAX_TOOL_BODY_BYTES,
    onError: (c) => c.json(invalid(`A request body may be at most ${MAX_TOOL_BODY_BYTES} bytes`), 400),
  });
  /** The parsed body, or the 400 to answer. */
  async function read<S extends z.ZodType>(
    c: Context,
    schema: S,
  ): Promise<{ ok: true; tenantId: string | undefined; body: z.infer<S> } | { ok: false; response: Response }> {
    const tenantId = tenantOf(c);
    if (tenantId === false)
      return { ok: false, response: c.json(invalid(`The ${TENANT_HEADER} header must name a Tenant`), 400) };
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

  if (options.keys)
    mountKeysRoutes(app, {
      authorized,
      keys: options.keys,
      logger: options.logger ?? { info() {}, warn() {}, error() {} },
    });

  const mcp = options.mcp;
  if (mcp) {
    app.post(MCP_CONNECT_PATH, authorized, toolBodies, async (c) => {
      const request = await read(c, McpServerBodySchema);
      if (!request.ok) return request.response;
      return c.json(await mcp.connect(request.tenantId, request.body.server));
    });
    app.post(MCP_LIST_PATH, authorized, toolBodies, async (c) => {
      const request = await read(c, McpListBodySchema);
      if (!request.ok) return request.response;
      const { server, cursor } = request.body;
      return c.json(await mcp.list(request.tenantId, server, cursor, c.req.raw.signal));
    });
    app.post(MCP_CLOSE_PATH, authorized, toolBodies, async (c) => {
      const request = await read(c, McpServerBodySchema);
      if (!request.ok) return request.response;
      await mcp.close(request.body.server);
      return c.body(null, 204);
    });
    const toolCalls = options.toolCalls;
    app.post(`${TOOL_CALLS_PATH}/:key/cancel`, authorized, (c) => {
      if (tenantOf(c) === false)
        return c.json(invalid(`The ${TENANT_HEADER} header must name a Tenant`), 400);
      toolCalls?.cancel(c.req.param("key"));
      return c.body(null, 204);
    });
    app.post(TOOL_CALLS_PATH, authorized, toolBodies, async (c) => {
      const request = await read(c, ToolCallBodySchema);
      if (!request.ok) return request.response;
      const signal = c.req.raw.signal;
      const key = c.req.header("idempotency-key");
      try {
        // Keyed: the call runs under its own signal, once, and outlives this request (G3).
        const answer =
          key && toolCalls
            ? await untilAborted(
                toolCalls.run(
                  request.tenantId,
                  key,
                  createHash("sha256").update(canonical(request.body)).digest("hex"),
                  request.body,
                ),
                signal,
              )
            : await mcp.call(request.tenantId, request.body, signal);
        if (signal.aborted) return new Response(null, { status: 499 });
        return c.json(answer);
      } catch (error) {
        if (error instanceof InflightConflict) {
          const body: GateErrorBody = { error: { code: "gate_conflict", message: error.message } };
          return c.json(body, 409);
        }
        if (signal.aborted) return new Response(null, { status: 499 });
        throw error;
      }
    });
  }

  const policy = options.delivery;
  if (policy) {
    app.post(DELIVERIES_PATH, authorized, toolBodies, async (c) => {
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

  app.post(`${MODEL_CALLS_PATH}/:key/cancel`, authorized, (c) => {
    // Optional, as on a call: the gate serves one Tenant, so the key alone names the call.
    const tenantId = c.req.header(TENANT_HEADER);
    if (tenantId !== undefined && !isTenantId(tenantId))
      return c.json(invalid(`The ${TENANT_HEADER} header must name a Tenant`), 400);
    options.inflight.cancel(c.req.param("key"));
    return c.body(null, 204);
  });

  app.post(
    MODEL_CALLS_PATH,
    authorized,
    bodyLimit({
      maxSize,
      onError: (c) =>
        c.json(invalid(`A model call body may be at most ${maxSize} bytes`), 400),
    }),
    async (c) => {
      // Optional: the gate serves its database's one Tenant, and refuses a call naming another.
      const tenantId = c.req.header(TENANT_HEADER);
      if (tenantId !== undefined && !isTenantId(tenantId))
        return c.json(invalid(`The ${TENANT_HEADER} header must name a Tenant`), 400);
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(invalid("The body must be JSON"), 400);
      }
      const parsed = ModelCallBodySchema.safeParse(raw);
      if (!parsed.success)
        return c.json(invalid(`Invalid model call: ${parsed.error.issues[0]?.message ?? "malformed"}`), 400);
      const { call, ...ids } = parsed.data;
      const request = {
        ...(tenantId === undefined ? {} : { tenantId }),
        ...ids,
        call: call as unknown as RuntimeModelCall,
      };
      const signal = c.req.raw.signal;
      const key = c.req.header("idempotency-key");
      try {
        let outcome: ModelGateOutcome;
        if (key) {
          // Keyed: the call runs under its own signal and outlives this request (P1.2). The
          // gate serves one Tenant, so the effect id alone is the key.
          const hash = createHash("sha256").update(canonical(parsed.data)).digest("hex");
          outcome = await untilAborted(
            options.inflight.run(key, hash, (own) => options.modelGate.call(request, own)),
            signal,
          );
        } else outcome = await options.modelGate.call(request, signal);
        return c.json({ outcome });
      } catch (error) {
        if (error instanceof InflightConflict) {
          const body: GateErrorBody = { error: { code: "gate_conflict", message: error.message } };
          return c.json(body, 409);
        }
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
