/**
 * The Model Gate in the caller's own process: `piModel` with the Tenant's host model. Used
 * when nothing separates the loop from the credential anyway (the ephemeral Runtime,
 * embedding, tests), and by the gates service itself to serve each call.
 */
import type { Credential } from "@earendil-works/pi-ai";
import { piModel, type ModelCallSettings } from "../model/pi-model.js";
import type { SessionStore } from "../store/types.js";
import type { Logger } from "../tenant/types.js";
import { HostModelVault } from "../vault/host-model.js";
import type { HostModelSecret } from "../vault/service.js";
import { createMeter } from "./meter.js";
import type { ModelGate, ModelGateRequest } from "./model-gate.js";
import { artifactFiles, type FileResolver } from "../artifacts/files.js";
import type { BlobStore } from "../blob/index.js";

export interface InProcessModelGateOptions {
  /** The Tenant's home: `piModel` redacts secrets it finds there from failure messages. */
  readonly root?: string;
  readonly readHostModel: () => Promise<HostModelSecret | undefined>;
  /** Writes back a credential pi-ai refreshed (OAuth). */
  readonly writeHostCredential: (credential: Credential) => Promise<void>;
  readonly settings?: ModelCallSettings;
  /** Reads the files a call's prompt names (protocol 6): artifacts, for model-gate. */
  readonly files?: (request: ModelGateRequest) => FileResolver;
}

/**
 * The files a call names, from the Tenant's artifacts, limited to the call's session: in
 * process, the loop's own request; over HTTP, the session of the run token's claims, which the
 * gate's route puts on the request (F5). A request without a session reads no file at all.
 */
export function callFiles(
  store: SessionStore,
  blobs: BlobStore,
): (request: Pick<ModelGateRequest, "sessionId">) => FileResolver {
  return (request) => artifactFiles({ store, blobs, sessionId: request.sessionId });
}

/**
 * The in-process gate of an open Tenant: reads its host model from its own vault and records
 * each call in its usage ledger. Only a Runtime without the gates service (embedding, the
 * ephemeral Runtime, tests) builds one.
 */
export function tenantModelGate(options: {
  readonly store: SessionStore;
  readonly kek: () => Buffer;
  readonly root: string;
  readonly logger: Logger;
  readonly settings?: ModelCallSettings;
  /** The Tenant's Object store, for the files a prompt names. */
  readonly blobs?: BlobStore;
}): ModelGate {
  const vault = new HostModelVault({ store: options.store, kek: options.kek });
  const gate = inProcessModelGate({
    root: options.root,
    readHostModel: () => vault.readHostModel(),
    writeHostCredential: (credential) => vault.updateHostCredential(credential),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.blobs ? { files: callFiles(options.store, options.blobs) } : {}),
  });
  const meter = createMeter({ logger: options.logger });
  return {
    call: (request, signal) => meter.call(options.store, request, () => gate.call(request, signal)),
  };
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
        ...(options.files ? { files: options.files(request) } : {}),
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
