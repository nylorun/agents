import { Agent } from "@nylorun/agents/define";
import { codeMode } from "./tools.js";
import {
  exampleInstructions,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Code mode presents the tools catalog as a generated SDK; only run_code is callable directly. */
export async function createCodeMode(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const mode = await codeMode();
  const agent = Agent({
    id: "code-mode",
    name: "Code Mode",
  })
    .instructions(exampleInstructions, ...mode.instructions)
    .tools(...mode.tools)
    .build();
  return agent;
}
