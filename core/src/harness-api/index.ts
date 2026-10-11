/**
 * `@nylorun/core/harness-api`: the public contract between core and a harness (Harness API 2).
 * Everything a harness sends or reads has a schema here, and the Runtime validates with the same
 * schemas, so these types are the enforced ones: the frames and messages (`schema.ts`), the
 * transport and the pod join (`transport.ts`), the Model and Tool Gate bodies (`gates.ts`), the
 * MCP snapshot (`mcp.ts`), transcript entries and the effect id rule (`entries.ts`), the effect
 * request hash and transcript edits. No engine and no I/O.
 *
 * Three version numbers apply: the transport (path and header, 1), the messages
 * (`HARNESS_API_VERSION`, 2) and the Runtime protocol, which only the Runtime's own APIs carry.
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
  IntentAnswerSchema,
  OutcomeAnswerSchema,
  RecordedOutcomeSchema,
  RunGrantSchema,
  RunRoutingSchema,
  TraceContextSchema,
  TranscriptUpdateSchema,
  TurnOutputSchema,
  TurnStartSchema,
  coreMessages,
  coreRequests,
  harnessRequests,
  validateFrame,
  validateMessage,
  validateParams,
  validateResult,
} from "./schema.js";
export * from "./transport.js";
export * from "./gates.js";
export * from "./mcp.js";
export * from "./entries.js";
export type {
  ModelCall,
  ModelCallTool,
  ModelCandidate,
  ModelFailureCode,
  ModelFailureOutcome,
  ModelFinishReason,
  ModelOutputBlock,
  ModelToolCall,
  ModelUsage,
  PromptContentPart,
  PromptItem,
} from "../types/model.js";
export type { InputEvent, TranscriptEntry } from "../types/transcript.js";
export type { ToolResult } from "../types/tool.js";
export { harnessApiJsonSchema, harnessApiSchemas } from "./json-schema.js";
