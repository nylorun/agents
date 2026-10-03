import type { RunGrant, TurnStart } from "@nylorun/core/harness-api";
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
 * What runs the effects the harness executes: model calls, MCP tools and sandbox tools. Core
 * runs everything else (Actions, hooks, flow work, linked sessions).
 */
export interface HarnessExecutors {
  /** A model call. A provider failure is a failure outcome; only an abort throws. */
  model(effect: HostEffect, signal: AbortSignal, run: HarnessRun): Promise<unknown>;
  /** An MCP or sandbox tool call, routed by `run.start.routing`. */
  tool(effect: HostEffect, signal: AbortSignal, run: HarnessRun): Promise<unknown>;
  /**
   * Calls that outlive this process at their gate: a shutdown leaves them running there, and
   * the next run re-sends them (`rejoin`) instead of marking them uncertain.
   */
  readonly recovers: {
    readonly model: boolean;
    remoteMcp(effect: HostEffect, run: HarnessRun): boolean;
  };
  /** Stops a recoverable tool call at its gate after a user cancel. Never rejects. */
  cancelAtGate?(effect: HostEffect, run: HarnessRun): Promise<void>;
  /** F6.2: discovers the session's MCP tools in the harness. */
  prepare?(
    run: HarnessRun,
  ): Promise<{ sessionTools: readonly DurableSessionTool[]; record?: unknown }>;
}
