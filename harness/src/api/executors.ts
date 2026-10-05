import type { ParamsOf, ResultOf, RunGrant, TurnStart } from "@nylorun/core/harness-api";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";

/** A run as the harness holds it: the lease, what it started from, and its signal. */
export interface HarnessRun {
  readonly runId: string;
  /** The current grant; a renewal may replace its run token. */
  readonly grant: RunGrant;
  readonly start: TurnStart;
  readonly signal: AbortSignal;
}

/**
 * What runs the effects the harness executes: model calls, MCP, HTTP and sandbox tools. Core
 * runs everything else (Actions, flow work, linked sessions).
 */
export interface HarnessExecutors {
  /** A model call. A provider failure is a failure outcome; only an abort throws. */
  model(effect: HostEffect, signal: AbortSignal, run: HarnessRun): Promise<unknown>;
  /** An MCP, HTTP or sandbox tool call, routed by `run.start.routing`. */
  tool(effect: HostEffect, signal: AbortSignal, run: HarnessRun): Promise<unknown>;
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
   * Readies the session's MCP servers before an agent's segment runs (F6.2): discovers their
   * tools the first time, reconnects them after. `record` keeps what it found in the session
   * (`session.mcp`; the first snapshot recorded wins) and answers the session's snapshot and
   * tools, which the segment runs with. Undefined: nothing to change.
   */
  prepare?(run: HarnessRun, record: McpRecorder): Promise<PreparedRun | undefined>;
}

/** Records a session's MCP discovery in core (`session.mcp`). */
export type McpRecorder = (
  params: Omit<ParamsOf<"session.mcp">, "runId">,
) => Promise<ResultOf<"session.mcp">>;

/** The session's MCP snapshot and tools after `prepare`. */
export interface PreparedRun {
  readonly sessionTools: readonly DurableSessionTool[];
  readonly mcpSnapshot?: unknown;
}
