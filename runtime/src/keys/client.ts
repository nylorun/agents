/**
 * The runtime container's client of the `keys` service in the gateway (F4.2, `contract.ts`).
 * Over `node:http` rather than `fetch`, which tests and embedders may replace. A refusal comes
 * back as the error the operation threw in the gateway (`VaultError` or `HttpError`, same status,
 * code and details); a hop failure is a 503, so the API route answers that the gateway is down.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { HttpError } from "../tenant/http.js";
import { VaultError } from "../vault/error.js";
import { KEYS_PATH, type KeysAnswer } from "./contract.js";
import { KEYS_OPERATIONS, type Keys, type KeysOperation } from "./keys.js";

/** Signing and vault writes are short; anything slower is a gateway in trouble. */
const KEYS_TIMEOUT_MS = 30_000;

export interface HttpKeysOptions {
  /** The gateway, e.g. `http://gateway:4100` (`NYLORUN_KEYS_URL`). */
  readonly url: string;
  /** `NYLORUN_GATES_TOKEN`. */
  readonly token: string;
  readonly timeoutMs?: number;
}

export function httpKeys(options: HttpKeysOptions): Keys {
  const where = new URL(options.url).origin;
  const timeoutMs = options.timeoutMs ?? KEYS_TIMEOUT_MS;

  function call(operation: KeysOperation, args: readonly unknown[]): Promise<unknown> {
    const url = new URL(`${KEYS_PATH}/${operation}`, options.url);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = Buffer.from(JSON.stringify({ args }), "utf8");
    return new Promise((resolve, reject) => {
      const unavailable = (detail: string) =>
        reject(
          new HttpError(503, `The keys service at ${where} is unavailable (${detail}); check the gateway container`, {
            code: "keys_unavailable",
          }),
        );
      const outgoing = send(
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "content-length": payload.byteLength,
          },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", (error) => unavailable(error.message));
          response.on("end", () => {
            let answer: KeysAnswer | undefined;
            try {
              answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as KeysAnswer;
            } catch {
              answer = undefined;
            }
            if (response.statusCode !== 200 || !answer)
              return unavailable(
                response.statusCode === 401
                  ? "it refused this Runtime's token: the runtime and gateway containers must share NYLORUN_GATES_TOKEN"
                  : `it answered ${response.statusCode}`,
              );
            if ("result" in answer) return resolve(answer.result);
            const error = answer.error;
            reject(
              error.kind === "vault"
                ? new VaultError(error.status, error.message)
                : new HttpError(error.status, error.message, {
                    ...(error.code === undefined ? {} : { code: error.code }),
                    ...(error.details === undefined ? {} : { details: error.details }),
                  }),
            );
          });
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error(`no answer in ${timeoutMs / 1000} s`)));
      outgoing.on("error", (error) => unavailable(error.message));
      outgoing.end(payload);
    });
  }

  const keys = {} as Record<KeysOperation, (...args: unknown[]) => Promise<unknown>>;
  for (const operation of KEYS_OPERATIONS)
    keys[operation] = (...args: unknown[]) => call(operation, args);
  return keys as unknown as Keys;
}
