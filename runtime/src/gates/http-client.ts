/**
 * The loop's client of the gates service (blueprint §15, P1.1): each vault-backed model call
 * is one POST to the gate and one JSON answer, `gates/contract.ts`. The loop never sees the
 * model credential.
 *
 * Over `node:http`, not `fetch`: the gate answers only when the call has finished, and
 * `fetch`'s default 300 s headers timeout would end every longer call. The only timeout here
 * is the socket's idle time, above the gate's own 600 s provider timeout.
 *
 * A failure of the hop is a failure outcome, never a throw: `resolveEffect` marks anything
 * thrown `uncertain`. Only an abort of the caller's signal throws. The client never retries;
 * the gate retries the provider.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ModelFailureOutcome } from "@nylorun/core/define";
import { failure } from "../model/classify.js";
import {
  MODEL_CALLS_PATH,
  TENANT_HEADER,
  type GateErrorBody,
  type ModelCallBody,
} from "./contract.js";
import type { ModelGate, ModelGateOutcome } from "./model-gate.js";

/** Above the gate's 600 s provider request timeout. */
export const GATE_CLIENT_TIMEOUT_MS = 630_000;

export interface HttpModelGateOptions {
  /** The gates service, e.g. `http://gateway:4100` (`NYLORUN_GATES_URL`). */
  readonly url: string;
  /** `NYLORUN_GATES_TOKEN`. */
  readonly token: string;
  /** How long the connection may stay silent. Default `GATE_CLIENT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export function httpModelGate(options: HttpModelGateOptions): ModelGate {
  const endpoint = new URL(MODEL_CALLS_PATH, options.url);
  const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
  const timeoutMs = options.timeoutMs ?? GATE_CLIENT_TIMEOUT_MS;
  const where = new URL(options.url).origin;

  return {
    async call(request, signal) {
      signal.throwIfAborted();
      const body: ModelCallBody = {
        sessionId: request.sessionId,
        turnId: request.turnId,
        effectId: request.effectId,
        invocationId: request.invocationId,
        call: request.call as unknown as ModelCallBody["call"],
      };
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      return new Promise<ModelGateOutcome>((resolve, reject) => {
        let settled = false;
        /** True once the whole request was handed to the socket. */
        let sent = false;
        /** True once the gate's answer started; its body settles the call. */
        let responded = false;
        let timedOut = false;
        const settle = (outcome: ModelGateOutcome) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          outgoing.destroy();
          reject(signal.reason ?? new Error("aborted"));
        };
        const lost = (error?: Error) =>
          settle(
            timedOut
              ? failure("transient", `Model gate at ${where} sent nothing for ${Math.round(timeoutMs / 1000)} s`, true)
              : sent
                ? failure(
                    "transient",
                    `Model gate connection lost mid-call${error ? ` (${error.message})` : ""}; the provider may have billed the call`,
                    true,
                  )
                : failure(
                    "transient",
                    `Model gate unreachable at ${where}${error ? ` (${error.message})` : ""}`,
                    true,
                  ),
          );

        const outgoing = send(
          endpoint,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.token}`,
              "content-type": "application/json",
              "content-length": payload.byteLength,
              [TENANT_HEADER]: request.tenantId,
              "idempotency-key": request.effectId,
            },
            timeout: timeoutMs,
          },
          (response) => {
            responded = true;
            readBody(response).then(
              (text) => settle(answer(response.statusCode ?? 0, text)),
              (error: Error) => lost(error),
            );
          },
        );
        outgoing.on("socket", (socket) => socket.setKeepAlive(true, 30_000));
        outgoing.on("finish", () => {
          sent = true;
        });
        outgoing.on("timeout", () => {
          timedOut = true;
          outgoing.destroy();
        });
        outgoing.on("error", (error) => {
          if (signal.aborted) return;
          lost(error);
        });
        outgoing.on("close", () => {
          if (!signal.aborted && !responded) lost();
        });
        signal.addEventListener("abort", onAbort, { once: true });
        outgoing.end(payload);
      });
    },
  };
}

function readBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      if (response.complete) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error("response ended early"));
    });
    response.on("error", reject);
    response.on("aborted", () => reject(new Error("response aborted")));
  });
}

/** The outcome a gate answer stands for. */
function answer(status: number, text: string): ModelGateOutcome | ModelFailureOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (status === 200) {
    if (typeof parsed === "object" && parsed !== null && "outcome" in parsed)
      return (parsed as { outcome: ModelGateOutcome }).outcome;
    return failure("transient", "Model gate answered without an outcome", false);
  }
  const message = (parsed as GateErrorBody | undefined)?.error?.message;
  if (status === 401)
    return failure(
      "auth",
      "The model gate refused this Runtime's token: the runtime and gateway containers must share NYLORUN_GATES_TOKEN",
      false,
    );
  if (status === 400)
    return failure("invalid_request", message ?? "The model gate refused the call", false);
  return failure("transient", `Model gate answered ${status}${message ? `: ${message}` : ""}`, true);
}
