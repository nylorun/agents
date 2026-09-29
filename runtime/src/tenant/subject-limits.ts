/**
 * Subject limits (Host feature `subject-tokens`): a subject token's role may cap how many turns
 * its subject starts per hour and how many run at once. Every turn spends the Tenant's model
 * budget, so these ship with the first credential that reaches the Runtime without an app
 * server in between.
 *
 * Turns per hour is a token bucket per subject (capacity `turnsPerHour`, refilled
 * continuously): no hourly rows and no burst at a window boundary. Concurrent turns counts the
 * subject's sessions with work in flight; `paused` is not counted, so an unanswered approval
 * never locks a person out. Checked inside the command's transaction, after the session row
 * lock, so one subject's messages serialize on the bucket row.
 */
import type { RoleLimits } from "@nylorun/core/contracts";
import type { Tx } from "../store/types.js";
import { fail } from "./http.js";

/** Session statuses that hold a turn in flight. */
const ACTIVE_STATUSES = ["runnable", "running", "waiting"] as const;
const CONCURRENT_RETRY_SECONDS = 5;
/** Floating-point slack when a refill lands exactly on a whole turn. */
const EPSILON = 1e-9;

/** Charges one turn to `subject`, or answers `429 limit_exceeded`. */
export async function chargeTurn(
  t: Tx,
  subject: string,
  limits: RoleLimits,
  now = Date.now()
): Promise<void> {
  if (limits.concurrentTurns !== undefined) {
    const active = await t.countOwnerSessions(subject, ACTIVE_STATUSES);
    if (active >= limits.concurrentTurns)
      fail(
        429,
        `At most ${limits.concurrentTurns} turns may run at once`,
        {
          code: "limit_exceeded",
          details: {
            limit: "concurrentTurns",
            retryAfterSeconds: CONCURRENT_RETRY_SECONDS,
          },
        },
        { "retry-after": String(CONCURRENT_RETRY_SECONDS) }
      );
  }
  const capacity = limits.turnsPerHour;
  if (capacity === undefined) return;
  const perMs = capacity / 3_600_000;
  const usage = await t.lockSubjectUsage({
    subject,
    turnTokens: capacity,
    refilledAt: new Date(now).toISOString(),
  });
  const elapsed = Math.max(0, now - Date.parse(usage.refilledAt));
  const tokens = Math.min(capacity, usage.turnTokens + elapsed * perMs);
  if (tokens < 1 - EPSILON) {
    // Rounded before the ceiling so floating-point dust never adds a second.
    const wait = Math.round(((1 - tokens) / perMs / 1000) * 1000) / 1000;
    const retryAfterSeconds = Math.max(1, Math.ceil(wait));
    fail(
      429,
      `At most ${capacity} turns per hour`,
      {
        code: "limit_exceeded",
        details: { limit: "turnsPerHour", retryAfterSeconds },
      },
      { "retry-after": String(retryAfterSeconds) }
    );
  }
  await t.putSubjectUsage({
    subject,
    turnTokens: Math.max(0, tokens - 1),
    refilledAt: new Date(now).toISOString(),
  });
}
