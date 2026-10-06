import { Agent } from "@nylorun/agents/define";
import { codexTools } from "./capability.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Coding work is handed to the host-installed Codex CLI in a temporary workspace. */
export function createCodingAgent(deps: AgentDependencies): ExampleAgent {
  const agent = Agent({
    id: "coding-agent",
    name: "Coding Agent",
  })
    .instructions(
      exampleInstructions,
      "For coding tasks, ask for approval then call codex_exec. Report Codex stdout. The workspace is a temporary directory, not this repository.",
    )
    .capability(modelSelection(deps.provider, deps.model))
    .capability(codexTools(new Map()))
    .build();
  return agent;
}
