/**
 * Serves one model call in the gates service: opens the Tenant's vault and calls the model
 * through `inProcessModelGate`, the same code the loop ran before the gate, so outcomes,
 * retries, classification and redaction are unchanged. Logs one line per call, never the
 * prompt, the output or a credential.
 */
import { classifyThrown } from "../model/classify.js";
import type { Logger } from "../tenant/types.js";
import { inProcessModelGate } from "./in-process.js";
import type { ModelCallSettings, ModelGate } from "./model-gate.js";
import { GateRefusal, type TenantVaults } from "./tenant-vaults.js";

export interface ModelCallHandlerOptions {
  readonly vaults: TenantVaults;
  readonly logger: Logger;
  /** Retries and timeouts; `piModel`'s defaults when absent. */
  readonly settings?: ModelCallSettings;
}

export function createModelCallHandler(options: ModelCallHandlerOptions): ModelGate {
  const { vaults, logger, settings } = options;
  return {
    async call(request, signal) {
      const started = Date.now();
      let outcome;
      try {
        const vault = await vaults.open(request.tenantId);
        outcome = await inProcessModelGate({
          root: vault.root,
          readHostModel: () => vault.readHostModel(),
          writeHostCredential: (credential) => vault.writeHostCredential(credential),
          ...(settings ? { settings } : {}),
        }).call(request, signal);
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

const fields = (request: Parameters<ModelGate["call"]>[0]) => ({
  tenant: request.tenantId,
  session: request.sessionId,
  effect: request.effectId,
  ...(request.call.model?.id ? { model: request.call.model.id } : {}),
});
