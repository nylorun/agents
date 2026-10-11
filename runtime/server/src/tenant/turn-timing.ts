/**
 * A turn's timing and totals (R7.1), so the event that ends it is its span. The session body
 * keeps when its active turn started (`turnStartedAt`, set beside `activeTurnId`), how long it
 * has waited paused for a person (`pausedMs`), and since when it waits (`pausedAt`, while
 * paused). `turn.completed`, `turn.failed` and `turn.cancelled` carry `endTurn`'s facts.
 *
 * A turn started before the Runtime recorded these has no `turnStartedAt`: its end carries no
 * `durationMs`.
 */
import type { Tx } from "../store/types.js";
import { durationBetween } from "./transcript.js";

/** The turn timing a session body keeps. */
export interface TurnTiming {
  turnStartedAt?: string;
  pausedMs?: number;
  pausedAt?: string;
}

/** A new turn starts now. Mutates `s`. */
export function startTurn(s: TurnTiming, now = new Date()): void {
  s.turnStartedAt = now.toISOString();
  s.pausedMs = 0;
  delete s.pausedAt;
}

/** The turn waits for a person from now, unless it already does. Mutates `s`. */
export function pauseTurn(s: TurnTiming, now = new Date()): void {
  s.pausedAt ??= now.toISOString();
}

/** A paused turn goes on: its wait is added to `pausedMs`. No-op when it was not paused. */
export function resumeTurn(s: TurnTiming, now = new Date()): void {
  if (s.pausedAt === undefined) return;
  s.pausedMs = (s.pausedMs ?? 0) + (durationBetween(s.pausedAt, now.toISOString()) ?? 0);
  delete s.pausedAt;
}

/**
 * The facts the event that ends turn `turnId` carries: `durationMs` from its start to now, waits
 * included, so the turn's span holds every crossing in it; `pausedMs`, how long it waited paused
 * (a wait still open ends now, as for a cancel); the session's agent;
 * and the turn's totals from the usage ledger (one read, as `/v1/tenant/usage` totals a turn;
 * `steps` are the model calls the gate metered). Clears the turn's timing from `s`.
 */
export async function endTurn(
  t: Tx,
  s: TurnTiming & { agentId: string },
  turnId: string | null,
  now = new Date(),
): Promise<{
  durationMs?: number;
  pausedMs?: number;
  agentId: string;
  totals?: { steps: number; tokens: number; costUsd: number };
}> {
  resumeTurn(s, now);
  const elapsed = durationBetween(s.turnStartedAt, now.toISOString());
  const totals = turnId ? await t.modelUsageTotals({ scope: "turn", id: turnId }) : undefined;
  const facts = {
    ...(elapsed === undefined ? {} : { durationMs: Math.max(0, elapsed), pausedMs: s.pausedMs ?? 0 }),
    agentId: s.agentId,
    ...(totals ? { totals: { steps: totals.calls, tokens: totals.tokens, costUsd: totals.costUsd } } : {}),
  };
  delete s.turnStartedAt;
  delete s.pausedMs;
  return facts;
}
