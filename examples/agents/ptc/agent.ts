import { Agent } from "@nylorun/agents/define";
import { programmaticToolCalling } from "./tools.js";
import {
  exampleInstructions,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Programmatic tool calling (PTC) presents the tools catalog as a generated SDK; only run_code is callable directly. */
export async function createPtc(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const ptc = await programmaticToolCalling();
  const agent = Agent({
    id: "ptc",
    name: "Programmatic Tool Calling",
  })
    .instructions(exampleInstructions, ...ptc.instructions)
    .tools(...ptc.tools)
    .build();
  return agent;
}
