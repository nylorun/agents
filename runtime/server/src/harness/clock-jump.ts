/**
 * Notices that the process was frozen and resumed, as an Agent Substrate actor is by a memory
 * snapshot's restore: a timer that should fire every `intervalMs` finds the wall clock moved on
 * by more than `jumpMs` beyond that. A pod's engine uses it to drop a connection attempt the
 * freeze caught in flight (its packets went with the old network, so it would wait for TCP to
 * send them again, 1 s and then 3 s; P1.8's third run) and to dial again at once.
 *
 * An event loop held up as long (a long GC pause) reads as a jump too; the caller only redials,
 * so that costs one connection attempt, never a working connection.
 */
export interface ClockJumpWatch {
  stop(): void;
}

export function watchClockJumps(
  onJump: (jumpedMs: number) => void,
  options: { intervalMs?: number; jumpMs?: number; now?: () => number } = {},
): ClockJumpWatch {
  const intervalMs = options.intervalMs ?? 100;
  const jumpMs = options.jumpMs ?? 1_500;
  const now = options.now ?? Date.now;
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - intervalMs;
    last = at;
    if (late > jumpMs) onJump(late);
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
