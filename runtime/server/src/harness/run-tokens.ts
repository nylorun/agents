/**
 * The run tokens of a harness process (F5, F6.2): the credential of its model and MCP calls at
 * the gates. Each comes with a run (the `lease` answer's grant) or a renewal (`lease.renew`);
 * the HTTP gate clients read a session's token on every request (`RunTokens`).
 *
 * A session's last token is kept after its run ends, so a pooled MCP connection closed later
 * (idle, or at shutdown) still presents one: a close the gate refuses is ignored, and the
 * gateway's own idle timeout closes the rest. A harness never holds `NYLORUN_GATES_TOKEN`.
 */
import type { RunGrant } from "@nylorun/core/harness-api";

export interface HarnessRunTokens {
  /** The latest run token of `sessionId`, if a run of it was ever leased here. */
  token(sessionId: string): string | undefined;
  /** Keeps a run's grant: `createHarness({ onGrant })`. */
  grant(grant: RunGrant): void;
}

/** Remembers the last token of at most `limit` sessions (least recently granted dropped first). */
export function harnessRunTokens(limit = 10_000): HarnessRunTokens {
  const tokens = new Map<string, string>();
  return {
    token: (sessionId) => tokens.get(sessionId),
    grant(grant) {
      if (!grant.token) return;
      tokens.delete(grant.sessionId);
      tokens.set(grant.sessionId, grant.token);
      if (tokens.size > limit) tokens.delete(tokens.keys().next().value!);
    },
  };
}
