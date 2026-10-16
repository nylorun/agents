/** A token count with thousands separators. */
export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

/** A cost in US dollars: cents above a cent, else down to a hundredth of a cent. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return usd < 0.0001 ? "<$0.0001" : `$${usd.toFixed(4)}`;
}

/** What a session's usage totals leave out or count twice, one sentence each. */
export function usageNotes(totals: {
  duplicates: number;
  unpricedCalls: number;
  unreportedCalls: number;
}): string[] {
  const calls = (n: number, one: string, many: string) =>
    n === 1 ? `1 model call ${one}` : `${n} model calls ${many}`;
  const notes: string[] = [];
  if (totals.duplicates > 0)
    notes.push(
      calls(
        totals.duplicates,
        "was sent twice; both sends were billed and are counted.",
        "were sent twice; both sends were billed and are counted.",
      ),
    );
  if (totals.unreportedCalls > 0)
    notes.push(
      calls(totals.unreportedCalls, "reported no tokens and counts as 0.", "reported no tokens and count as 0."),
    );
  if (totals.unpricedCalls > 0)
    notes.push(
      calls(totals.unpricedCalls, "has no known price and costs $0 here.", "have no known price and cost $0 here."),
    );
  return notes;
}
