import { Agent } from "@nylorun/agents/define";
import {
  inputGuardrail,
  lookup,
  outputGuardrail,
  publish,
  toolInputGuardrail,
  toolOutputGuardrail,
} from "./capability.js";
import { tools } from "../shared/tools/index.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Input, output, tool-input, and tool-output policy around publish and lookup. */
export async function createGuardrails(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const agent = Agent({
    id: "guardrails",
    name: "Guardrails",
  })
    .instructions(exampleInstructions)
    .capability(modelSelection(deps.provider, deps.model))
    .capability(await tools())
    .capability(publish)
    .capability(lookup)
    // Guardrails are middleware: they run in the local engine only, not on the Runtime.
    .capability({ id: "input", middleware: inputGuardrail })
    .capability({ id: "output", middleware: outputGuardrail })
    .capability({ id: "tool-input", middleware: toolInputGuardrail })
    .capability({ id: "tool-output", middleware: toolOutputGuardrail })
    .build();
  return agent;
}
