/**
 * The Model Gate seam (blueprint §15, P1.1). Every vault-backed model call of the loop goes
 * through one `ModelGate`: the call, who it is for, and nothing else. The gate owns what the
 * call needs that the loop must not hold: the provider credential, pi-ai, its retries and
 * idle watchdog, failure classification and scrubbing.
 *
 * Two implementations: `inProcessModelGate` (embedding, the ephemeral Runtime, tests) and the
 * HTTP client of the gates service (the `gateway` container), which keeps the credential out
 * of the loop process. Both return what `piModel` returns, so the effect journal is the same
 * either way.
 */
import type { RuntimeModelAdapter, RuntimeModelCall } from "../contracts.js";

export type { ModelCallSettings } from "../model/pi-model.js";

/** One model call, as the loop hands it to the gate. JSON-safe: it crosses the network. */
export interface ModelGateRequest {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** The effect's journal id; sent as `Idempotency-Key` (acted on from P1.2). */
  readonly effectId: string;
  readonly invocationId: string;
  readonly call: RuntimeModelCall;
}

/** A model candidate or a failure outcome: exactly what `piModel` returns. */
export type ModelGateOutcome = Awaited<ReturnType<RuntimeModelAdapter>>;

export interface ModelGate {
  /**
   * Calls the model. A provider or gate failure comes back as a failure outcome; only an abort
   * of `signal` throws, so the advance decides what the abort means.
   */
  call(request: ModelGateRequest, signal: AbortSignal): Promise<ModelGateOutcome>;
}
