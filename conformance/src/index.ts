/**
 * @nylorun/harness-conformance: checks a harness against the Harness API (track R4, R4.7) by
 * driving a live Runtime through its public Runtime and Management APIs. It never imports the
 * Runtime: what it sees is what any client sees.
 */
export { CHECKS, checkInfo, type CheckClass, type CheckInfo, type Need } from "./catalog.js";
export {
  RuntimeClient,
  RuntimeError,
  type ClientOptions,
  type ModelCallRow,
  type RecordEvent,
  type SessionView,
  type ToolCallRow,
} from "./client.js";
export * as evaluate from "./evaluate.js";
export type { TurnObservation, Verdict } from "./evaluate.js";
export {
  runConformance,
  type CheckResult,
  type ConformanceOptions,
  type ConformanceReport,
  type Status,
} from "./run.js";
export { jsonLine, summary, tableRow } from "./report.js";
