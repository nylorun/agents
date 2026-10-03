/**
 * `@nylorun/core/harness-api`: the protocol between core and a harness (Harness API v1). Types,
 * schemas, the effect request hash, transcript edits and the RPC channel; no engine and no I/O.
 */
export * from "./messages.js";
export { HarnessApiError } from "./errors.js";
export { effectRequestHash, requestIdentity } from "./hash.js";
export {
  CHUNK_BYTES,
  TranscriptFoldError,
  applyUpdate,
  applyUpdates,
  transcriptOf,
  transcriptUpdates,
  withTranscript,
  type TranscriptUpdate,
} from "./transcript.js";
export {
  createChannel,
  memoryChannels,
  memoryPorts,
  type Frame,
  type HarnessChannel,
  type MemoryPortsOptions,
  type MessageListener,
  type Port,
  type RequestHandler,
} from "./rpc.js";
export {
  EffectIntentSchema,
  FrameSchema,
  TurnOutputSchema,
  TurnStartSchema,
  validateFrame,
  validateMessage,
  validateParams,
  validateResult,
} from "./schema.js";
