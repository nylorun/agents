import type { McpFacts, ParamsOf, ResultOf, RunGrant, TurnStart } from "@nylorun/core/harness-api";
import type { HostEffect } from "../run/durable.js";

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

/** One regular file under a directory `HarnessFiles.list` listed. */
export interface HarnessFileEntry {
  /** Relative to the directory listed, `/`-separated, never `.` or `..` segments. */
  readonly path: string;
  readonly size: number;
}

/**
 * The run's sandbox files, which our engine decides about and the host only executes (protocol
 * 15): bytes for its artifact tools (`save_artifact` reads a file, `read_artifact` with `path`
 * writes one), a listing and reads for the outputs folder it saves at a turn's end, and the skill
 * folders it mounts before a sandbox call. Each runs in the session's sandbox queue. Paths are the
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
  /**
   * The regular files under directory `dir`, recursively, in path order: at most `maxEntries`,
   * with `truncated` when there are more. `missing` when `dir` is not a directory, or the sandbox
   * was never created (nothing is started to look).
   */
  list(
    run: HarnessRun,
    dir: string,
    maxEntries: number,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "listed";
        readonly entries: readonly HarnessFileEntry[];
        readonly truncated: boolean;
      }
    | { readonly kind: "missing" }
    | FailedFileOutcome
  >;
  /**
   * Writes `files` (path in `folder` to `sha256:<hex>`) to `folder`, read-only, each one's bytes
   * from `read`: `mounted`. A folder this sandbox already holds, since it last started, is
   * `present`, and nothing is written. A partial copy a failed mount left is replaced.
   */
  mount(
    run: HarnessRun,
    folder: string,
    files: Readonly<Record<string, string>>,
    read: (sha256: string) => AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "mounted" | "present" } | FailedFileOutcome>;
}

/**
 * What runs the effects the harness executes: model calls (always through the Model Gate), MCP,
 * HTTP and sandbox tools, and the sandbox files our engine uses. Our engine runs its own tools (`harness` calls:
 * the skill tools over `definition.file`, the artifact tools over the artifact seam,
 * `tool_search` over the run's MCP tools) and shapes every tool result before it is recorded;
 * core runs flow work and linked sessions.
 */
export interface HarnessExecutors {
  /** A model call. A provider failure is a failure outcome; only an abort throws. */
  model(effect: HostEffect, signal: AbortSignal, run: HarnessRun): Promise<unknown>;
  /**
   * An MCP, HTTP or sandbox tool call, routed by its `target` and `run.start.routing`: an MCP
   * call names its server and the server's own tool name, an HTTP call the declared tool, and a
   * `sandbox` call runs in the sandbox `routing.sandbox.spec` names. What it answers is the
   * tool's whole result: our engine shapes it before it is recorded. `call.traceparent` is the
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
   * tools when the run has no MCP facts yet (`turn.start.mcp`), reconnects them after. `record`
   * keeps what it found in the session (`session.mcp`; the first snapshot recorded wins) and
   * answers the facts the segment runs with. Undefined: nothing to change.
   */
  prepare?(run: HarnessRun, record: McpRecorder): Promise<PreparedRun | undefined>;
  /**
   * The run's sandbox files. Undefined: a `path` of an artifact tool fails `artifact.no_sandbox`,
   * no skill folder is mounted and no outputs folder is saved.
   */
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

/** The session's MCP facts after `prepare`, as the turn sees them. */
export interface PreparedRun {
  readonly mcp?: McpFacts;
}
