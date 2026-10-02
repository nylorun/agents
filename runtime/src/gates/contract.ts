/**
 * The gates service's wire format (blueprint §15, P1.1). Internal: only the loop calls it, so
 * it is not in the published OpenAPI documents.
 *
 * `POST /nylorun/v1/model-calls`
 * - Headers: `Authorization: Bearer <NYLORUN_GATES_TOKEN>`, `Nylorun-Tenant: <tenant id>`,
 *   `Idempotency-Key: <effect id>` (logged; acted on from P1.2).
 * - Body: `ModelCallBody`, at most `MAX_MODEL_CALL_BYTES`.
 * - `200 {outcome}` once the call has finished, whether the outcome is a candidate or a
 *   failure; nothing is sent while it runs. `401 gate_unauthorized` for a missing or wrong
 *   token, `400 invalid_request` for a bad Tenant header or body.
 */
import { z } from "zod";
import type { ModelGateOutcome } from "./model-gate.js";

export const MODEL_CALLS_PATH = "/nylorun/v1/model-calls";

/** Header naming the Tenant a call is for. */
export const TENANT_HEADER = "nylorun-tenant";

/** Largest request body the gate reads: one `ModelCall` with its whole projected history. */
export const MAX_MODEL_CALL_BYTES = 32 * 1024 * 1024;

export const ModelCallBodySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  effectId: z.string().min(1),
  invocationId: z.string().min(1),
  call: z.looseObject({
    prompt: z.array(z.unknown()),
    tools: z.array(z.looseObject({ name: z.string() })),
  }),
});

export type ModelCallBody = z.infer<typeof ModelCallBodySchema>;

export interface ModelCallResponse {
  readonly outcome: ModelGateOutcome;
}

/** An error answer: `{error: {code, message}}`. */
export interface GateErrorBody {
  readonly error: {
    readonly code: "gate_unauthorized" | "invalid_request";
    readonly message: string;
  };
}
