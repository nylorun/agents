/**
 * The gates service's HTTP routes (blueprint §15, P1.1): the Model Gate's IR endpoint, and the
 * health and readiness probes. Internal: only the loop calls them, with the stack's gates
 * token, so they are not in the published OpenAPI documents. The wire format is
 * `gates/contract.ts`.
 */
import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
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
import { InflightConflict, type InflightCalls } from "../../gates/inflight.js";
import type { ModelGate, ModelGateOutcome } from "../../gates/model-gate.js";
import { adminKeyMatches } from "../../host/http.js";
import { canonical } from "../../store/canonical.js";

export interface GatesAppOptions {
  /** The bearer every model call must present (`NYLORUN_GATES_TOKEN`). */
  readonly token: string;
  /** Serves an authenticated, well-formed call. */
  readonly modelGate: ModelGate;
  /** Keyed calls, which outlive their client (P1.2). */
  readonly inflight: InflightCalls;
  /** Whether the gate's dependencies answer (Postgres). */
  readonly ready: () => Promise<boolean>;
  /** Largest body read. Default `MAX_MODEL_CALL_BYTES`. */
  readonly maxBodyBytes?: number;
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

  app.post(`${MODEL_CALLS_PATH}/:key/cancel`, authorized, (c) => {
    const tenantId = c.req.header(TENANT_HEADER);
    if (!isTenantId(tenantId))
      return c.json(invalid(`The ${TENANT_HEADER} header must name a Tenant`), 400);
    options.inflight.cancel(`${tenantId}:${c.req.param("key")}`);
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
      const tenantId = c.req.header(TENANT_HEADER);
      if (!isTenantId(tenantId))
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
      const request = { tenantId, ...ids, call: call as unknown as RuntimeModelCall };
      const signal = c.req.raw.signal;
      const key = c.req.header("idempotency-key");
      try {
        let outcome: ModelGateOutcome;
        if (key) {
          // Keyed: the call runs under its own signal and outlives this request (P1.2).
          const hash = createHash("sha256").update(canonical(parsed.data)).digest("hex");
          outcome = await untilAborted(
            options.inflight.run(`${tenantId}:${key}`, hash, (own) =>
              options.modelGate.call(request, own),
            ),
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
