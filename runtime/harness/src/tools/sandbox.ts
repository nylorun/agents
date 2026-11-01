/**
 * Our engine's sandbox tools (protocol 15): `bash`, `read`, `write`, `edit`, `grep` and `glob`,
 * offered to an agent of a session with a sandbox (`turn.start.agent.sandbox`), all six or those
 * its manifest declares (ADR-100, `engine.sandbox`), with the note on the sandbox that goes with
 * them. Our engine names, describes and instructs them (`@nylorun/core/engine`, which the SDK's
 * `previewTurn` reads too); each call is a `sandbox` effect named by its operation, which the host
 * runs in the session's sandbox (`executors.tool`), so the record keeps `environment.exec` and the
 * sandbox's network policy holds.
 *
 * Their limits are the harness's configuration (`SandboxToolLimits`): the schema maxima and
 * defaults the model reads here, and the same numbers where the host runs the call.
 */
export {
  DEFAULT_SANDBOX_TOOL_LIMITS,
  sandboxToolLimitsOf,
  sandboxTools,
  type SandboxToolLimits,
} from "@nylorun/core/engine";
/** The note on the sandbox the model reads with the sandbox tools (block `sandbox`). */
export { sandboxNote as sandboxInstructions } from "@nylorun/core/engine";
