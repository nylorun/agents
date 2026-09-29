import { Agent } from "@nylorun/agents/define";
import { createInstructions } from "../instructions/agent.js";
import { createSkills } from "../skills/agent.js";
import { createToolUse } from "../tool-use/agent.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/**
 * A parent that delegates to the Instructions, Skills, and Tool Use examples.
 * Each subagent becomes a tool named after its id; its description is the routing text.
 * The engine runs each one with a fresh context and returns only its final answer.
 */
export async function createSubagents(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const [instructions, skills, toolUse] = await Promise.all([
    createInstructions(deps),
    createSkills(deps),
    createToolUse(deps),
  ]);
  return Agent({ id: "subagents", name: "Subagents" })
    .instructions(
      exampleInstructions,
      "Do not do specialist work yourself. Delegate each task to the matching agent.",
      "Write each task so it stands on its own: the agent sees nothing but the task.",
    )
    .subagents(instructions, skills, toolUse)
    .capability(modelSelection(deps.provider, deps.model))
    .build();
}
