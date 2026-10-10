/**
 * Keyed tool calls in the gates service (F4.1 G3): remote MCP calls and HTTP tool calls (R2 M3).
 * A call sent with an `Idempotency-Key` (the loop's effect id) runs once:
 *
 * - While it runs, and for 30 minutes after, a re-send joins it or gets its answer from memory
 *   (`inflight.ts`), as model calls do (P1.2). So a runtime that dies or shuts down mid-call
 *   leaves nothing `uncertain`: the next owner re-sends the call and gets its answer.
 * - The gate also writes a `tool_crossings` row before it calls the server, and the answer
 *   after. A re-send that finds the answer gets it. One that finds a row without an answer,
 *   for a call this gateway is not running, was lost with an earlier gateway (a restart mid
 *   call): it answers `uncertain`, because the call may have run, and is never run again.
 *
 * A cancel aborts the call and leaves its row without an answer. Settled rows are deleted a day
 * later (`prune`).
 */
import type { Logger } from "../tenant/types.js";
import {
  createInflightCalls,
  InflightConflict,
  type InflightCallsOptions,
  type InflightOwner,
} from "./inflight.js";
import type { TenantVaults } from "./tenant-vaults.js";
import type { McpAnswer } from "./tool-contract.js";

/** How long a settled crossing is kept. */
export const TOOL_CROSSING_TTL_MS = 24 * 60 * 60_000;

/** A tool call's answer: an MCP `CallToolResult`, or an HTTP tool's outcome. */
export type ToolCallAnswer = McpAnswer<Record<string, unknown>>;

export interface ToolCalls {
  /**
   * Runs `call` under `key`, joins the call running under it, or answers it from its crossing.
   * Rejects with `InflightConflict` when a different request (`hash`) already ran under it, and
   * as `InflightCalls.run` does for `owner`, the run that sends it (F5).
   */
  run(
    tenantId: string | undefined,
    key: string,
    hash: string,
    call: (signal: AbortSignal) => Promise<ToolCallAnswer>,
    owner?: InflightOwner,
  ): Promise<ToolCallAnswer>;
  /**
   * Aborts the call under `key`; it is never run again under that key. With `sessionId`, false
   * when the running call is another session's (nothing is aborted).
   */
  cancel(key: string, sessionId?: string): boolean;
  /** Aborts every running call (gateway shutdown). */
  close(): void;
  /** Deletes crossings settled more than `TOOL_CROSSING_TTL_MS` ago. */
  prune(): Promise<void>;
}

export interface ToolCallsOptions {
  readonly vaults: TenantVaults;
  readonly logger: Logger;
  readonly inflight?: InflightCallsOptions;
  readonly now?: () => number;
}

const LOST: ToolCallAnswer = {
  ok: false,
  error: {
    uncertain: true,
    message:
      "The gateway stopped while this tool call ran; the call may have reached its server, so it is not run again",
  },
};

export function createToolCalls(options: ToolCallsOptions): ToolCalls {
  const { vaults, logger } = options;
  const now = options.now ?? Date.now;
  const inflight = createInflightCalls<ToolCallAnswer>(options.inflight);
  const iso = () => new Date(now()).toISOString();

  return {
    async run(tenantId, key, hash, call, owner) {
      if (inflight.has(key)) return inflight.run(key, hash, () => Promise.resolve(LOST), owner);
      const vault = await vaults.open(tenantId);
      const store = vault.store;
      const row = await store.tx((t) => t.toolCrossing(key));
      if (row) {
        if (row.hash !== hash) throw new InflightConflict(`A different request already ran under ${key}`);
        if (row.answer !== null && row.answer !== undefined) return row.answer as ToolCallAnswer;
        // Started here a moment ago, or lost with an earlier gateway.
        if (inflight.has(key)) return inflight.run(key, hash, () => Promise.resolve(LOST), owner);
        return LOST;
      }
      return inflight.run(key, hash, async (signal) => {
        const started = await store.tx((t) =>
          t.startToolCrossing({ key, hash, startedAt: iso() }),
        );
        // Another gateway process wrote it between the read and now: never run it twice.
        if (!started) return LOST;
        const answer = await call(signal);
        // A cancel or a shutdown: the call may have reached the server; the row stays open.
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        await store
          .tx((t) => t.settleToolCrossing(key, answer, iso()))
          .catch((error: unknown) =>
            logger.warn("tool_crossing_unsettled", {
              effect: key,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        return answer;
      }, owner);
    },
    cancel: (key, sessionId) => inflight.cancel(key, sessionId),
    close: () => inflight.close(),
    async prune() {
      try {
        const vault = await vaults.open(undefined);
        const before = new Date(now() - TOOL_CROSSING_TTL_MS).toISOString();
        await vault.store.tx((t) => t.pruneToolCrossings(before));
      } catch {
        // The database is not ready yet; the next pass prunes.
      }
    },
  };
}
