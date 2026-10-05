import { Agent, VerdictSchema, tool } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * A flow agent that uses a map, a loop, agents and a tool: plan, implement each task, open
 * a PR. Each stage gets the previous output, so each agent returns what the next stage
 * needs: the planner `{ items }` for the map, the PR writer `{ summaries }` for `open-pr`.
 * Design: docs/design/agent/flow-agents.md
 */
const planner = Agent({
  id: "planner",
  name: "Feature planner",
  description: "Breaks a feature request into implementable tasks.",
})
  .instructions("Plan the feature as a list of short tasks. Return { items: string[] }.")
  .output(z.object({ items: z.array(z.string()) }));

const coder = Agent({
  id: "coder",
  name: "Feature coder",
  description: "Implements one task and returns a summary.",
})
  .instructions("Implement the given task. Return a one-line summary of what you did.")
  .output(z.object({ summary: z.string() }));

const reviewer = Agent({
  id: "reviewer",
  name: "Change reviewer",
  description: "Checks that a change summary says what changed.",
})
  .instructions("Pass the response when its summary says what changed; otherwise say what is missing.")
  .output(VerdictSchema);

const prWriter = Agent({
  id: "pr-writer",
  name: "PR writer",
  description: "Collects implementation summaries for a pull request.",
})
  .instructions("You get one { summary } per task. Return their summaries, in order.")
  .output(z.object({ summaries: z.array(z.string()) }));

const openPr = tool({
  name: "open-pr",
  description: "Opens a pull request from implementation summaries.",
  input: z.object({ summaries: z.array(z.string()) }),
  output: z.object({ opened: z.boolean(), count: z.number() }),
  async run({ summaries }, ctx) {
    if (!(await ctx.approve("Open the PR?"))) throw new Error("Rejected");
    return { opened: true, count: summaries.length };
  },
});

export const shipFeature = Agent({
  id: "ship-feature",
  name: "Ship feature",
  description: "Plans a feature, implements each task, and opens a pull request.",
})
  .pipe(planner)
  .map(Agent({ id: "code" }).loop(coder, { verify: reviewer, max: 2 }), { id: "implement" })
  .pipe(prWriter, openPr);
