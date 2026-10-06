import { Agent } from "@nylorun/agents/define";
import { codeMode } from "./capability.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Code mode presents the tools catalog as a generated SDK; only run_code is callable directly. */
export async function createCodeMode(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const agent = Agent({
    id: "code-mode",
    name: "Code Mode",
  })
    .instructions(exampleInstructions)
    .capability(modelSelection(deps.provider, deps.model))
    .capability(await codeMode())
    .build();
  return agent;
}
