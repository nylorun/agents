/**
 * The `keys` service's route on the gateway's listener (F4.2, `contract.ts`): one operation of
 * `Keys` per request, run with the vault key of the gateway's Tenant. Errors keep their status,
 * code and details. Logs the operation, its outcome and an internal failure's cause, never an
 * argument or a result.
 */
import type { Env, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "../../tenant/http.js";
import type { Logger } from "../../tenant/types.js";
import { VaultError } from "../../vault/error.js";
import { KEYS_PATH, type KeysAnswer, type KeysError } from "../../keys/contract.js";
import { hostTuning } from "../../tuning.js";
import { KEYS_OPERATIONS, type Keys, type KeysOperation } from "../../keys/keys.js";

export function mountKeysRoutes<E extends Env>(
  app: Hono<E>,
  options: {
    /** Core's credential: no run token reaches the keys (F5). */
    readonly authorized: MiddlewareHandler<E>;
    /** The gateway's Tenant's keys; rejects when the Tenant is not ready. */
    readonly keys: () => Promise<Keys>;
    readonly logger: Logger;
  },
): void {
  app.post(
    `${KEYS_PATH}/:operation`,
    options.authorized,
    // The largest request body: a credential with its secret, or a token's claims (`keys.bodyBytes`).
    (c, next) =>
      bodyLimit({
        maxSize: hostTuning().keys.bodyBytes,
        onError: (c) => c.json({ error: { code: "invalid_request", message: "The body is too large" } }, 400),
      })(c, next),
    async (c) => {
      const operation = c.req.param("operation");
      if (!(KEYS_OPERATIONS as readonly string[]).includes(operation))
        return c.json({ error: { code: "invalid_request", message: `Unknown keys operation ${operation}` } }, 404);
      let args: unknown;
      try {
        args = ((await c.req.json()) as { args?: unknown }).args;
      } catch {
        args = undefined;
      }
      if (!Array.isArray(args))
        return c.json({ error: { code: "invalid_request", message: "The body must be {args: [...]}" } }, 400);
      const started = Date.now();
      let answer: KeysAnswer;
      try {
        const keys = await options.keys();
        const run = keys[operation as KeysOperation] as (...values: unknown[]) => Promise<unknown>;
        answer = { result: (await run.apply(keys, args)) ?? null };
      } catch (error) {
        answer = { error: errorOf(error) };
        // The caller sees only "The keys service failed": the cause is logged, never the args.
        if (answer.error.status === 500)
          options.logger.error("keys_request_failed", {
            operation,
            error: (error as Error | undefined)?.message ?? String(error),
            stack: (error as Error | undefined)?.stack,
          });
      }
      options.logger.info("keys_request", {
        operation,
        ms: Date.now() - started,
        outcome: "result" in answer ? "ok" : String(answer.error.status),
      });
      return c.json(answer);
    },
  );
}

function errorOf(error: unknown): KeysError {
  if (error instanceof VaultError)
    return {
      kind: "vault",
      status: error.status,
      message: error.message,
      ...(error.rejection.code === undefined ? {} : { code: error.rejection.code }),
      ...(error.rejection.details === undefined ? {} : { details: error.rejection.details }),
    };
  if (error instanceof HttpError)
    return {
      kind: "http",
      status: error.status,
      message: error.message,
      ...(error.rejection.code === undefined ? {} : { code: error.rejection.code }),
      ...(error.rejection.details === undefined ? {} : { details: error.rejection.details }),
    };
  // A request error the route would answer 400 for, or an internal failure.
  const zod = (error as { name?: string } | undefined)?.name === "ZodError";
  return {
    kind: "http",
    status: zod ? 400 : 500,
    message: zod ? (error as Error).message : "The keys service failed",
  };
}
