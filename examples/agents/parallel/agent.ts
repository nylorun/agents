import { Agent } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Parallel: a fixed set of named branches at the same time, same input.
 * Design: docs/design/agent/flow-agents.md
 */
const Finding = z.object({ finding: z.string() });

const securityReviewer = Agent({
  id: "security-reviewer",
  name: "Security reviewer",
  description: "Reviews a change for security issues.",
})
  .instructions("Review for security. Return a short finding.")
  .output(Finding);

const styleReviewer = Agent({
  id: "style-reviewer",
  name: "Style reviewer",
  description: "Reviews a change for style.",
})
  .instructions("Review for style. Return a short finding.")
  .output(Finding);

const testAuditor = Agent({
  id: "test-auditor",
  name: "Test auditor",
  description: "Reviews a change for test coverage.",
})
  .instructions("Review tests. Return a short finding.")
  .output(Finding);

const summarizer = Agent({
  id: "summarizer",
  name: "Summarizer",
  description: "Merges parallel review findings.",
}).instructions("Combine the review findings into one short summary.");

export const prReview = Agent({
  id: "pr-review",
  name: "PR review",
  description: "Reviews a change for security, style and tests at once, then summarizes.",
})
  .parallel(
    { security: securityReviewer, style: styleReviewer, tests: testAuditor },
    { id: "review" },
  )
  .step(summarizer, {
    input: ({ input }) => `Summarize these reviews:\n${JSON.stringify(input, null, 2)}`,
  });
