/**
 * Core's metrics: how long turns take and how long queued messages wait. Both are
 * recorded only for committed changes, by the process that committed them, so a rolled-back
 * transaction records nothing and no point is recorded twice.
 *
 * - `gen_ai.invoke_agent.duration` (s) from each committed `turn.completed`, `turn.failed` and
 *   `turn.cancelled`: the turn's `durationMs` (its start to its end, waits for a person
 *   included), with `gen_ai.operation.name` `invoke_agent`, `gen_ai.agent.name` (the agent
 *   manifest's name) and, unless it completed, `error.type` (the failure's code, `turn.failed`
 *   without one, or `cancelled`). A turn the Runtime has no start for records nothing.
 * - `nylorun.queue.wait` (s) for each queued message a turn takes, that fails or that is
 *   cancelled, from when it was queued, with `nylorun.queue.outcome` `taken`, `failed` or
 *   `cancelled`.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import type { Commit, Tx } from "../store/types.js";
import { defined, instruments } from "./telemetry.js";

const TURN_ENDS: ReadonlySet<string> = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);

/** A Session Store commit listener recording the turns it ended. */
export function recordTurnEnds(commit: Pick<Commit, "events">): void {
  for (const event of commit.events) if (TURN_ENDS.has(event.type)) recordTurnEnd(event);
}

function recordTurnEnd(event: Pick<LiveEvent, "type" | "payload">): void {
  const payload = (event.payload ?? {}) as {
    durationMs?: unknown;
    manifest?: { name?: unknown };
    error?: { code?: unknown };
  };
  if (typeof payload.durationMs !== "number" || !Number.isFinite(payload.durationMs) || payload.durationMs < 0) return;
  const name = payload.manifest?.name;
  const errorType =
    event.type === "turn.failed"
      ? typeof payload.error?.code === "string"
        ? payload.error.code
        : "turn.failed"
      : event.type === "turn.cancelled"
        ? "cancelled"
        : undefined;
  instruments().invokeAgentDuration.record(
    payload.durationMs / 1000,
    defined({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": typeof name === "string" ? name : undefined,
      "error.type": errorType,
    }),
  );
}

/** How a queued message left the queue. */
export type QueueOutcome = "taken" | "failed" | "cancelled";

/** Records, once `t` commits, how long each of `rows` waited since it was queued. */
export function recordQueueWaits(
  t: Pick<Tx, "afterCommit">,
  rows: readonly { readonly createdAt: string }[],
  outcome: QueueOutcome,
  now: () => number = Date.now,
): void {
  if (rows.length === 0) return;
  const queued = rows.map((row) => Date.parse(row.createdAt)).filter((at) => Number.isFinite(at));
  t.afterCommit(() => {
    const at = now();
    const wait = instruments().queueWait;
    for (const from of queued) wait.record(Math.max(0, at - from) / 1000, { "nylorun.queue.outcome": outcome });
  });
}
