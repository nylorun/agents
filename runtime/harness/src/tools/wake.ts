/**
 * `schedule_wake` (track T4, D77): the agent books its own session's next turn, "check the deploy
 * again in two hours". Offered when the version the session runs sets `runtime.selfWake`
 * (`turn.start.agent.selfWake`). The Runtime serves it (a `runtime` effect): it writes the booking
 * in the call's own transaction, keyed by the call, so a replayed turn books once. A session holds
 * one booking; a new one replaces it. The booked turn starts with the note as its message.
 */
import type { DurableSessionTool } from "../run/durable.js";

const RUNTIME_WAKE = { kind: "runtime", operation: "schedule_wake" } as const;

/** The tool, and the text the model reads with it. */
export function wakeTool(): { tool: DurableSessionTool; instructions: string } {
  return {
    tool: {
      name: "schedule_wake",
      description:
        "Book this session's next turn for later, when nobody may be here to ask: give `in` (a duration such as 30m, 2h or 1d) or `at` (an RFC 3339 time with an offset), and a `note` that will be your message at that turn. A session holds one booking: a new one replaces it, and `cancel: true` removes it. Returns when it is booked for.",
      inputSchema: {
        type: "object",
        properties: {
          in: {
            type: "string",
            pattern: "^[1-9][0-9]*(s|m|h|d)$",
            description: "How long from now: 30m, 2h, 1d.",
          },
          at: {
            type: "string",
            description: "An RFC 3339 time with an offset, such as 2026-11-01T09:00:00+05:30.",
          },
          note: {
            type: "string",
            minLength: 1,
            description: "What to do then, in your own words: your message at that turn.",
          },
          cancel: { type: "boolean", description: "Remove the session's booking instead." },
        },
        additionalProperties: false,
      },
      target: RUNTIME_WAKE,
    },
    instructions:
      "You can book this session's next turn with schedule_wake, to check on something later or keep a routine going. Booking again replaces the booking you have.",
  };
}
