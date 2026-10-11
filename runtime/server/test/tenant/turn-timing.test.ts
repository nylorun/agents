/**
 * A turn's timing (R7.1, `tenant/turn-timing.ts`): its end carries its running time, waits for a
 * person included, how long it waited, its agent and its totals from the usage ledger.
 */
import { describe, expect, it } from "vitest";
import type { ModelUsageQuery, Tx } from "../../src/store/types.js";
import { endTurn, pauseTurn, resumeTurn, startTurn, type TurnTiming } from "../../src/tenant/turn-timing.js";

const at = (seconds: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, seconds));

function ledger(queries: ModelUsageQuery[]): Tx {
  return {
    async modelUsageTotals(query: ModelUsageQuery) {
      queries.push(query);
      return { calls: 2, tokens: 30, costUsd: 0.25 };
    },
  } as unknown as Tx;
}

describe("turn timing", () => {
  it("counts the waits for a person in the turn's duration and reports them apart", async () => {
    const s: TurnTiming & { agentId: string } = { agentId: "bot" };
    startTurn(s, at(0));
    pauseTurn(s, at(10));
    // A second pause while paused keeps the first one's start.
    pauseTurn(s, at(12));
    resumeTurn(s, at(40));
    // Resuming a turn that runs changes nothing.
    resumeTurn(s, at(41));
    expect(s).toMatchObject({ pausedMs: 30_000 });
    const queries: ModelUsageQuery[] = [];
    expect(await endTurn(ledger(queries), s, "turn-1", at(50))).toEqual({
      durationMs: 50_000,
      pausedMs: 30_000,
      agentId: "bot",
      totals: { steps: 2, tokens: 30, costUsd: 0.25 },
    });
    expect(queries).toEqual([{ scope: "turn", id: "turn-1" }]);
    expect(s).toEqual({ agentId: "bot" });
  });

  it("ends an open wait at the turn's end, as a cancel of a paused turn does", async () => {
    const s: TurnTiming & { agentId: string } = { agentId: "bot" };
    startTurn(s, at(0));
    pauseTurn(s, at(5));
    expect(await endTurn(ledger([]), s, "turn-1", at(60))).toMatchObject({ durationMs: 60_000, pausedMs: 55_000 });
  });

  it("has no duration for a turn started before the Runtime recorded its start", async () => {
    const facts = await endTurn(ledger([]), { agentId: "bot" }, "turn-1", at(60));
    expect(facts).not.toHaveProperty("durationMs");
    expect(facts.agentId).toBe("bot");
  });
});
