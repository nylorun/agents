import { Agent } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Loop: run, verify, and run again with the feedback until it passes or `max` is reached.
 * Design: docs/design/agent/flow-agents.md
 */
const coder = Agent({
  id: "coder",
  name: "Coder",
  description: "Produces a short answer that should satisfy a check.",
})
  .instructions("Answer the task. Prefer one clear sentence.")
  .output(z.object({ answer: z.string() }));

export const polish = Agent({
  id: "polish",
  name: "Polish",
  description: "Asks the coder again until the answer is long enough.",
}).loop(coder, {
  verify: ({ output }) =>
    output.answer.trim().length >= 8
      ? { pass: true }
      : { pass: false, feedback: "Answer must be at least eight characters. Try again." },
  max: 3,
});
