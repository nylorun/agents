/**
 * The Model Gate in the caller's own process: `piModel` with the Tenant's host model. Used
 * when nothing separates the loop from the credential anyway (the ephemeral Runtime,
 * embedding, tests), and by the gates service itself to serve each call.
 */
import type { Credential } from "@earendil-works/pi-ai";
import { piModel, type ModelCallSettings } from "../model/pi-model.js";
import type { HostModelSecret } from "../vault/service.js";
import type { ModelGate } from "./model-gate.js";

export interface InProcessModelGateOptions {
  /** The Tenant's home: `piModel` redacts secrets it finds there from failure messages. */
  readonly root?: string;
  readonly readHostModel: () => Promise<HostModelSecret | undefined>;
  /** Writes back a credential pi-ai refreshed (OAuth). */
  readonly writeHostCredential: (credential: Credential) => Promise<void>;
  readonly settings?: ModelCallSettings;
}

export function inProcessModelGate(options: InProcessModelGateOptions): ModelGate {
  return {
    async call(request, signal) {
      // One adapter per call, as before the gate: it reads the host model when invoked.
      const adapter = piModel({
        ...(options.root !== undefined ? { root: options.root } : {}),
        readHostModel: options.readHostModel,
        writeHostCredential: options.writeHostCredential,
        ...(options.settings ? { settings: options.settings } : {}),
      });
      return adapter(request.call, {
        // The Runtime never journals the provider request (harness `durable.ts`), and
        // `piModel` doesn't read it.
        request: undefined as never,
        invocationId: request.invocationId,
        signal,
        reportPreparedCall() {},
      });
    },
  };
}
