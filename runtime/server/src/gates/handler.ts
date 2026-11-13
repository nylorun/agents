/**
 * Serves one model call in the gates service: opens the Tenant's vault (the database's one
 * Tenant; a call naming another is refused) and calls the model (the fixture model while the
 * Tenant's `model.fixture` is on, R4.3) through `inProcessModelGate`, the same code the loop ran before the gate, so outcomes,
 * retries, classification and redaction are unchanged. The meter records the call's usage in
 * the Tenant's ledger. Logs one line per call, with its attempts, and one per retry, never the
 * prompt, the output or a credential.
 */
import { classifyThrown } from "../model/classify.js";
import type { Logger } from "../tenant/types.js";
import type { BlobStore } from "../blob/index.js";
import { callCaller, callFiles, inProcessModelGate, modelCallSettings, serve } from "./in-process.js";
import { createMeter } from "./meter.js";
import type { ModelGate, ModelGateRequest } from "./model-gate.js";
import { GateRefusal, type TenantVaults } from "./tenant-vaults.js";

export interface ModelCallHandlerOptions {
  readonly vaults: TenantVaults;
  readonly logger: Logger;
  /** The Object store, for the files a prompt names (protocol 6). */
  readonly blobs?: BlobStore;
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
  const { vaults, logger, blobs } = options;
  const meter = createMeter({ logger });
  return {
    async call(named, signal) {
      const started = Date.now();
      let request: ModelCallRequest = named;
      let outcome;
      // Attempts the call made, the first included: more than 1 when it was retried.
      let attempts = 1;
      try {
        const vault = await vaults.open(named.tenantId);
        const call = { ...named, tenantId: vault.tenantId };
        request = call;
        const gate = inProcessModelGate({
          root: vault.root,
          readHostModel: (request) => vault.readHostModel(request.sessionId),
          writeHostCredential: (credential, provider) => vault.writeHostCredential(credential, provider),
          // The Tenant's Runtime limits `model*`, read for this call.
          settings: await modelCallSettings(vault.store),
          ...(blobs ? { files: callFiles(vault.store, blobs) } : {}),
          caller: callCaller(vault.store),
          onRetry: (_request, retry) => {
            attempts = retry.attempt;
            logger.info("model_retry", {
              ...fields(call),
              attempt: retry.attempt,
              of: retry.maxAttempts,
              delayMs: retry.delayMs,
              error: retry.errorMessage.slice(0, 300),
            });
          },
        });
        outcome = await meter.call(vault.store, call, () => serve(vault.store, gate, call, signal));
      } catch (error) {
        if (signal.aborted) {
          logger.info("model_call", { ...fields(request), ms: Date.now() - started, attempts, outcome: "aborted" });
          throw error;
        }
        outcome = error instanceof GateRefusal ? error.outcome : classifyThrown(error);
      }
      logger.info("model_call", {
        ...fields(request),
        ms: Date.now() - started,
        attempts,
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
