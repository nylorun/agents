/**
 * The gates service's wire format (blueprint §15, P1.1). Not in the published OpenAPI documents:
 * harnesses call it, and its bodies are published in `@nylorun/core/harness-api` (R4.5).
 *
 * `POST /nylorun/v1/model-calls`
 * - Headers: `Authorization: Bearer <run token>` (F5, `tenant/run-token.ts`), `Idempotency-Key:
 *   <effect id>`, and optionally `Nylorun-Tenant: <tenant id>`, which must then be the token's
 *   Tenant. Core's credential (`NYLORUN_GATES_TOKEN`) is refused: only a run calls the model.
 * - Body: `ModelCallBody`, at most the Tenant's Runtime limit `modelCallBytes` (`PUT
 *   /v1/tenant/limits`, default 32 MiB). It names no session, turn or agent:
 *   the gate takes them from the token, and refuses a body that names them.
 * - `200 {outcome}` once the call has finished, whether the outcome is a candidate or a
 *   failure; nothing is sent while it runs. `401 gate_unauthorized` for a missing, malformed,
 *   expired or foreign token, `409 run_stale` when the token's lease is no longer the
 *   session's (a cancel, a new turn, a takeover), `400 invalid_request` for a malformed Tenant
 *   header or a bad body, `409 gate_conflict` when a different request already runs under the
 *   same key.
 * - With an `Idempotency-Key` the call outlives its client (P1.2): a re-send with the same key
 *   and body joins it, or gets its outcome for 30 minutes. Without one, a client that goes
 *   away aborts the call.
 *
 * `POST /nylorun/v1/model-calls/{key}/cancel` (same headers): aborts the keyed call; `204`
 * whether or not it exists, `403 gate_forbidden` when it is another session's call. The token
 * need not be live: a user cancel makes it stale, and still stops its call.
 */
import type { ModelGateOutcome } from "./model-gate.js";

export {
  MODEL_CALLS_PATH,
  ModelCallBodySchema,
  type GateErrorBody,
  type ModelCallBody,
} from "@nylorun/core/harness-api";

/** Header naming the Tenant a call is for: optional, and checked against the gate's Tenant. */
export const TENANT_HEADER = "nylorun-tenant";

export interface ModelCallResponse {
  readonly outcome: ModelGateOutcome;
}
