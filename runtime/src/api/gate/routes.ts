/**
 * The gates service's HTTP routes (blueprint §15, P1.1): the Model Gate's IR endpoint, and the
 * health and readiness probes. Internal: only the loop calls them, with the stack's gates
 * token, so they are not in the published OpenAPI documents. The wire format is
 * `gates/contract.ts`.
 */
import { Hono } from "hono";
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
import type { ModelGate } from "../../gates/model-gate.js";
import { adminKeyMatches } from "../../host/http.js";

export interface GatesAppOptions {
  /** The bearer every model call must present (`NYLORUN_GATES_TOKEN`). */
  readonly token: string;
  /** Serves an authenticated, well-formed call. */
  readonly modelGate: ModelGate;
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

  app.post(
    MODEL_CALLS_PATH,
    async (c, next) => {
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
    },
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
      const signal = c.req.raw.signal;
      try {
        const outcome = await options.modelGate.call(
          { tenantId, ...ids, call: call as unknown as RuntimeModelCall },
          signal,
        );
        return c.json({ outcome });
      } catch (error) {
        // The caller went away (or cancelled): nobody reads the answer.
        if (signal.aborted) return new Response(null, { status: 499 });
        throw error;
      }
    },
  );
  return app;
}
