/**
 * The A2A client side of `@nylorun/agents/a2a`, also exported from the package root: it loads
 * no Node-only module (the gateway's `toNodeListener` does).
 */
export {
  A2A_VERSION,
  A2aError,
  createA2aClient,
  listTurnChanges,
} from "./client.js";
export type {
  A2aAnswerOptions,
  A2aClient,
  A2aClientOptions,
  A2aListOptions,
  A2aSendOptions,
  ListTurnChangesOptions,
  TurnChange,
  TurnChangesPage,
} from "./client.js";
export { A2aPushVerificationError, verifyA2aPush } from "./push.js";
export type { A2aPushFailure, PushHeaders, VerifyA2aPushOptions } from "./push.js";
export {
  A2A_EXTENSIONS,
  A2A_PROFILE_EXTENSIONS,
  readEffects,
  readExtension,
  readFiles,
  readInteraction,
  readProgress,
  readTelemetry,
} from "./profile.js";
export type {
  A2aEffects,
  A2aExtensionUri,
  A2aFile,
  A2aFileArtifact,
  A2aInteraction,
  A2aPlanStep,
  A2aPlanStepState,
  A2aProgress,
  A2aTelemetry,
} from "./profile.js";
