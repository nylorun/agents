import { Agent, tool } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * A sequence: steps in order. Each step's output is the next step's input.
 * Design: docs/design/agent/flow-agents.md
 */
const researcher = Agent({
  id: "researcher",
  name: "Researcher",
  description: "Gathers findings for a topic. Returns a short findings string.",
})
  .instructions("Research the given topic. Reply with concise findings only.")
  .output(z.object({ findings: z.string() }));

const analyst = Agent({
  id: "analyst",
  name: "Analyst",
  description: "Summarizes research findings.",
})
  .instructions("Turn findings into a one-paragraph summary.")
  .output(z.object({ summary: z.string() }));

const publish = tool({
  name: "publish",
  description: "Records a finished summary.",
  input: z.object({ summary: z.string() }),
  output: z.object({ published: z.boolean(), summary: z.string() }),
  async run({ summary }) {
    return { published: true, summary };
  },
});

export const report = Agent({
  id: "report",
  name: "Report",
  description: "Researches a topic, summarizes the findings and records the summary.",
})
  .step(researcher)
  .step(analyst, {
    input: ({ results }) => `Summarize these findings:\n${results.researcher.findings}`,
  })
  .step(publish, { input: ({ input }) => ({ summary: input.summary }) });
