import type {
  McpSnapshot,
  ParamsOf,
  ResultOf,
  RunGrant,
  TurnStart,
} from "@nylorun/core/harness-api";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";

/** A run as the harness holds it: the lease, what it started from, and its signal. */
export interface HarnessRun {
  readonly runId: string;
  /** The current grant; a renewal may replace its run token. */
  readonly grant: RunGrant;
  readonly start: TurnStart;
  readonly signal: AbortSignal;
}

/** A failed tool outcome, as the model sees it. */
export interface FailedFileOutcome {
  readonly kind: "failed";
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/**
 * The run's sandbox files as bytes, for our engine's artifact tools (`save_artifact` reads a
 * file, `read_artifact` with `path` writes one), in the session's sandbox queue. Paths are the
 * model's: relative ones resolve in the workspace. A session without a sandbox, or a sandbox that
 * cannot start, answers a failed outcome.
 */
export interface HarnessFiles {
  /** A file's bytes: `missing` when there is none, failed when it is larger than `maxBytes`. */
  read(
    run: HarnessRun,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "read"; readonly path: string; readonly bytes: Uint8Array }
    | { readonly kind: "missing"; readonly path: string }
    | FailedFileOutcome
  >;
  /** Writes `body` to a file as it comes, making its folders; replaces a file there. */
  write(
    run: HarnessRun,
    path: string,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<
    { readonly kind: "written"; readonly path: string; readonly size: number } | FailedFileOutcome
  >;
}

/**
 * What runs the effects the harness executes: model calls, MCP, HTTP and sandbox tools, and the
 * sandbox files our engine's artifact tools use. Our engine runs its own tools (`harness` calls:
 * the skill tools over `definition.file`, the artifact tools over the artifact seam); core runs
 * flow work, linked sessions and `tool_search`.
 */
export interface HarnessExecutors {
  /** A model call. A provider failure is a failure outcome; only an abort throws. */
  model(effect: HostEffect, signal: AbortSignal, run: HarnessRun): Promise<unknown>;
  /**
   * An MCP, HTTP or sandbox tool call, routed by its `target` and `run.start.routing` (a
   * `sandbox` call runs in the sandbox `routing.sandbox.spec` names). `call.traceparent` is the
   * call's span context from core's `execute` answer (R7.4): a sandbox command gets it as
   * `TRACEPARENT`.
   */
  tool(
    effect: HostEffect,
    signal: AbortSignal,
    run: HarnessRun,
    call?: ToolCallContext,
  ): Promise<unknown>;
  /**
   * Calls that outlive this process at their gate: a shutdown leaves them running there, and
   * the next run re-sends them (`rejoin`) instead of marking them uncertain.
   */
  readonly recovers: {
    readonly model: boolean;
    /** True for a tool call at a gate that outlives this process (remote MCP, HTTP tools). */
    tool(effect: HostEffect, run: HarnessRun): boolean;
  };
  /** Stops a recoverable tool call at its gate after a user cancel. Never rejects. */
  cancelAtGate?(effect: HostEffect, run: HarnessRun): Promise<void>;
  /**
   * True when `error` says the hop to the tool call's gate lost its answer (R5.3): sending the
   * call again with the same key joins it, collects its answer, or runs it again. The harness
   * then asks core first (`effect.intent`), which counts the send and stops at its cap.
   */
  resends?(effect: HostEffect, error: unknown, run: HarnessRun): boolean;
  /**
   * Readies the session's MCP servers before an agent's segment runs (F6.2): discovers their
   * tools the first time, reconnects them after. `record` keeps what it found in the session
   * (`session.mcp`; the first snapshot recorded wins) and answers the session's snapshot and
   * tools, which the segment runs with. Undefined: nothing to change.
   */
  prepare?(run: HarnessRun, record: McpRecorder): Promise<PreparedRun | undefined>;
  /** The run's sandbox files. Undefined: a `path` of an artifact tool fails `artifact.no_sandbox`. */
  readonly files?: HarnessFiles;
}

/** What core's `execute` answer says of a tool call beside running it (R7.4). */
export interface ToolCallContext {
  readonly traceparent?: string;
}

/** Records a session's MCP discovery in core (`session.mcp`). */
export type McpRecorder = (
  params: Omit<ParamsOf<"session.mcp">, "runId">,
) => Promise<ResultOf<"session.mcp">>;

/** The session's MCP snapshot and tools after `prepare`. */
export interface PreparedRun {
  readonly sessionTools: readonly DurableSessionTool[];
  readonly mcpSnapshot?: McpSnapshot;
}
