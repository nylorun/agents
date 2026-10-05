import { Agent } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * A sequence: stages in order. Each stage gets the previous stage's output, so each agent's
 * output schema is what the next stage takes: the researcher returns the `{ findings }` the
 * analyst summarizes, and the analyst's `{ summary }` is the flow's output.
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
  .instructions("Turn the findings into a one-paragraph summary.")
  .output(z.object({ summary: z.string() }));

export const report = Agent({
  id: "report",
  name: "Report",
  description: "Researches a topic and summarizes the findings.",
})
  .pipe(researcher, analyst);
