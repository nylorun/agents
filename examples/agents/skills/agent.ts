import { projectAsset } from "@nylorun/runtime/node";
import { Agent } from "@nylorun/agents";
import { EXAMPLES_ROOT } from "../shared/root.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** The SKILL.md catalog: one folder per skill. */
export const SKILLS_CATALOG = projectAsset("agents/skills/catalog", EXAMPLES_ROOT);

/**
 * Skills are a SKILL.md catalog the Runtime serves: registering the agent uploads each skill's
 * files, the catalog stays in the instructions, and `load_skill` returns a skill's body.
 */
export async function createSkills(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  return Agent({
    id: "skills",
    name: "Skills",
    description: "Loads a SKILL.md procedure, such as a code review or a structured summary, and follows it.",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .skills(SKILLS_CATALOG, { id: "skills" })
    .build();
}
