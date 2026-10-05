import { Agent, VerdictSchema } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Loop: run, ask a verifier agent, and run again with its feedback until it passes or `max`
 * is reached. The verifier gets `{ task, response, iteration }` and returns a verdict.
 * Design: docs/design/agent/flow-agents.md
 */
const coder = Agent({
  id: "coder",
  name: "Coder",
  description: "Produces a short answer that should satisfy a check.",
})
  .instructions("Answer the task. Prefer one clear sentence.")
  .output(z.object({ answer: z.string() }));

const checker = Agent({
  id: "checker",
  name: "Checker",
  description: "Checks that an answer is a complete sentence.",
})
  .instructions(
    "Check the response's answer: it must be a complete sentence of at least eight characters. Return pass, and feedback when it fails.",
  )
  .output(VerdictSchema);

export const polish = Agent({
  id: "polish",
  name: "Polish",
  description: "Asks the coder again until the checker passes the answer.",
}).loop(coder, { verify: checker, max: 3 });
