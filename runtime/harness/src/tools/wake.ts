/**
 * `schedule_wake` (track T4, D77): the agent books its own session's next turn, "check the deploy
 * again in two hours". Offered when the version the session runs sets `runtime.selfWake`
 * (`turn.start.agent.selfWake`). The Runtime serves it (a `runtime` effect): it writes the booking
 * in the call's own transaction, keyed by the call, so a replayed turn books once. A session holds
 * one booking; a new one replaces it. The booked turn starts with the note as its message. The
 * tool and its text are `@nylorun/core/engine`'s (block `wake`).
 */
import { WAKE_TEXT, wakeToolOf } from "@nylorun/core/engine";
import type { DurableSessionTool } from "../run/durable.js";

/** The tool, and the text the model reads with it. */
export function wakeTool(): { tool: DurableSessionTool; instructions: string } {
  return { tool: wakeToolOf(), instructions: WAKE_TEXT };
}
