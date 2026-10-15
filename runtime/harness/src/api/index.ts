/**
 * `@nylorun/harness/api`: a harness over the Harness API (v4). It leases runs from core, resumes
 * the engine with a DurableHost over the record, and runs model, MCP and sandbox calls through
 * the executors it is given, and our engine's own tools over the artifact seam.
 */
export { createHarness, type Harness, type HarnessLogger, type HarnessOptions } from "./harness.js";
export { ABORT_MESSAGES, RunAbort, runAbortKind } from "./abort.js";
export type {
  FailedFileOutcome,
  HarnessExecutors,
  HarnessFiles,
  HarnessRun,
  McpRecorder,
  PreparedRun,
  ToolCallContext,
} from "./executors.js";
export { apiHost, type EngineToolConfig } from "./host.js";
export {
  artifactToolDeclarations,
  artifactToolsFor,
  isArtifactTool,
  runArtifactTool,
  type ArtifactToolContext,
  type ArtifactToolOptions,
} from "../tools/artifacts.js";
export { runTurn, type RunContext } from "./run.js";
export { TranscriptCache } from "./transcript-cache.js";
