/**
 * Serves one model call in the gates service: opens the Tenant's vault (the database's one
 * Tenant; a call naming another is refused) and calls the model
 * through `inProcessModelGate`, the same code the loop ran before the gate, so outcomes,
 * retries, classification and redaction are unchanged. The meter records the call's usage in
 * the Tenant's ledger. Logs one line per call, never the prompt, the output or a credential.
 */
import { classifyThrown } from "../model/classify.js";
import type { Logger } from "../tenant/types.js";
import { inProcessModelGate } from "./in-process.js";
import { createMeter } from "./meter.js";
import type { ModelCallSettings, ModelGate, ModelGateRequest } from "./model-gate.js";
import { GateRefusal, type TenantVaults } from "./tenant-vaults.js";

export interface ModelCallHandlerOptions {
  readonly vaults: TenantVaults;
  readonly logger: Logger;
  /** Retries and timeouts; `piModel`'s defaults when absent. */
  readonly settings?: ModelCallSettings;
}

/**
 * A model call as the gate receives it: the Tenant is optional (the loop of a protocol 4
 * Runtime names it; the gate serves the database's one Tenant either way).
 */
export type ModelCallRequest = Omit<ModelGateRequest, "tenantId"> & { readonly tenantId?: string };

/** What the gate's route calls: a `ModelGate` whose request may leave the Tenant out. */
export interface ModelCallHandler {
  call(request: ModelCallRequest, signal: AbortSignal): ReturnType<ModelGate["call"]>;
}

export function createModelCallHandler(options: ModelCallHandlerOptions): ModelCallHandler {
  const { vaults, logger, settings } = options;
  const meter = createMeter({ logger });
  return {
    async call(named, signal) {
      const started = Date.now();
      let request: ModelCallRequest = named;
      let outcome;
      try {
        const vault = await vaults.open(named.tenantId);
        const call = { ...named, tenantId: vault.tenantId };
        request = call;
        const gate = inProcessModelGate({
          root: vault.root,
          readHostModel: () => vault.readHostModel(),
          writeHostCredential: (credential) => vault.writeHostCredential(credential),
          ...(settings ? { settings } : {}),
        });
        outcome = await meter.call(vault.store, call, () => gate.call(call, signal));
      } catch (error) {
        if (signal.aborted) {
          logger.info("model_call", { ...fields(request), ms: Date.now() - started, outcome: "aborted" });
          throw error;
        }
        outcome = error instanceof GateRefusal ? error.outcome : classifyThrown(error);
      }
      logger.info("model_call", {
        ...fields(request),
        ms: Date.now() - started,
        outcome:
          typeof outcome === "object" && outcome !== null && "kind" in outcome
            ? outcome.code
            : "ok",
      });
      return outcome;
    },
  };
}

const fields = (request: ModelCallRequest) => ({
  tenant: request.tenantId,
  session: request.sessionId,
  effect: request.effectId,
  ...(request.call.model?.id ? { model: request.call.model.id } : {}),
});
