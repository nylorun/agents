import { Agent } from "@nylorun/agents/define";
import { z } from "zod";

/**
 * Map: the same stage once per item of a list, concurrently. A map runs over the previous
 * output's `items` (or over the output itself when it is an array); its output is the list
 * of results, in order.
 * Design: docs/design/agent/flow-agents.md
 */
const planner = Agent({
  id: "planner",
  name: "Section planner",
  description: "Plans sections for a digest.",
})
  .instructions("Plan section titles for the topic. Return { items: string[] }.")
  .output(z.object({ items: z.array(z.string()) }));

const sectionWriter = Agent({
  id: "section-writer",
  name: "Section writer",
  description: "Writes one section from a title.",
}).instructions("Write one short section for the given title.");

const editor = Agent({
  id: "editor",
  name: "Editor",
  description: "Joins sections into one digest.",
})
  .instructions("Join the sections you are given into one digest, in order.")
  .output(z.object({ digest: z.string() }));

export const digest = Agent({
  id: "digest",
  name: "Digest",
  description: "Plans sections, writes each one, and joins them into a digest.",
})
  .pipe(planner)
  .map(sectionWriter, { id: "write" })
  .pipe(editor);
