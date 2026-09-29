import { Agent, tool } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Map: the same step once per item of a list, concurrently.
 * Design: docs/design/agent/flow-agents.md
 */
const planner = Agent({
  id: "planner",
  name: "Section planner",
  description: "Plans sections for a digest.",
})
  .instructions("Plan section titles for the topic. Return { sections: string[] }.")
  .output(z.object({ sections: z.array(z.string()) }));

const sectionWriter = Agent({
  id: "section-writer",
  name: "Section writer",
  description: "Writes one section from a title.",
}).instructions("Write one short section for the given title.");

const merge = tool({
  name: "merge",
  description: "Joins section texts into one digest.",
  input: z.object({ parts: z.array(z.string()) }),
  output: z.object({ digest: z.string() }),
  async run({ parts }) {
    return { digest: parts.join("\n\n") };
  },
});

export const digest = Agent({
  id: "digest",
  name: "Digest",
  description: "Plans sections, writes each one, and joins them into a digest.",
})
  .step(planner)
  .map(sectionWriter, { id: "write", input: ({ input }) => input.sections })
  .step(merge, { input: ({ input }) => ({ parts: input }) });
