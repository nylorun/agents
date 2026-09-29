import { Agent, tool } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * A flow agent that uses a step, a map, a loop and a tool: plan, implement each task, open a PR.
 * Design: docs/design/agent/flow-agents.md
 */
const planner = Agent({
  id: "planner",
  name: "Feature planner",
  description: "Breaks a feature request into implementable tasks.",
})
  .instructions("Plan the feature as a list of short tasks. Return { tasks: string[] }.")
  .output(z.object({ tasks: z.array(z.string()) }));

const coder = Agent({
  id: "coder",
  name: "Feature coder",
  description: "Implements one task and returns a summary.",
})
  .instructions("Implement the given task. Return a one-line summary of what you did.")
  .output(z.object({ summary: z.string() }));

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
  .step(planner)
  .map(
    Agent({ id: "code" }).loop(coder, {
      verify: ({ output }) =>
        output.summary ? { pass: true } : { pass: false, feedback: "Say what you changed." },
      max: 2,
    }),
    { id: "implement", input: ({ input }) => input.tasks },
  )
  .step(openPr, {
    input: ({ input }) => ({ summaries: input.map((item) => item.summary) }),
  });
