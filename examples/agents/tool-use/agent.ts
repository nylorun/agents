import { Agent } from "@nylorun/agents/define";
import { tools } from "../shared/tools/index.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** A tool loop over the catalog's HTTP tools, with no policy or human approval. */
export async function createToolUse(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const agent = Agent({
    id: "tool-use",
    name: "Tool Use",
    description: "Calculates, reports the current time, and converts units with tools. Returns the result.",
  })
    .instructions(exampleInstructions)
    .capability(modelSelection(deps.provider, deps.model))
    .capability(await tools())
    .build();
  return agent;
}
