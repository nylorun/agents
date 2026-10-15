/**
 * A Model Gate over a `ModelProvider` (protocol 15): how a Runtime whose model is scripted (tests,
 * `model: {kind: "scripted"}` or `"fixture"`, an embedder's provider) serves its harness's model
 * calls. The harness calls the gate as it calls any (`invokeModel`), in process or not: no harness
 * calls a provider directly.
 *
 * The provider gets the call as an effect (`HostEffect`), rebuilt from the request: the ids, the
 * agent used as a tool, the call's purpose, and the call as its `input`. With a store, each call
 * is metered in the usage ledger like the Tenant's own gate's, and the Tenant's fixture model
 * setting is answered first (R4.3). It dies with its process: it never `recovers`.
 */
import type { HostEffect } from "@nylorun/harness/run";
import type { ModelProvider } from "../core/provider.js";
import type { SessionStore } from "../store/types.js";
import type { Logger } from "../tenant/types.js";
import { serve } from "./in-process.js";
import { createMeter } from "./meter.js";
import type { ModelGate, ModelGateOutcome, ModelGateRequest } from "./model-gate.js";

/** The effect a provider sees for `request`. */
export function providerEffect(request: ModelGateRequest): HostEffect {
  return {
    effectId: request.effectId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    agentId: request.agentId,
    // The gate is told no definition hash; a provider routes by the call, never by the hash.
    manifestHash: "",
    kind: "model",
    ...(request.agent === undefined ? {} : { agent: request.agent }),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    input: request.call,
    context: { invocationId: request.invocationId },
  };
}

export function providerModelGate(
  provider: ModelProvider,
  options: { readonly store?: SessionStore; readonly logger?: Logger } = {},
): ModelGate {
  const direct: ModelGate = {
    call: async (request, signal) => (await provider(providerEffect(request), signal)) as ModelGateOutcome,
  };
  const { store, logger } = options;
  if (!store || !logger) return direct;
  const meter = createMeter({ logger });
  return {
    call: (request, signal) => meter.call(store, request, () => serve(store, direct, request, signal)),
  };
}
