import { Agent } from "@nylorun/agents/define";
import { join } from "node:path";
import { askUser } from "./ask-user.js";
import { notes } from "./notes.js";
import { JsonlNotes } from "./notes-store.js";
import {
  exampleInstructions,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Human-in-the-loop: approval-gated writes and response questions. */
export function createInteractions(deps: AgentDependencies): ExampleAgent {
  const store = new JsonlNotes(
    join(deps.dataRoot, "interactions", "notes.jsonl"),
  );
  const notesParts = notes(store);
  const agent = Agent({
    id: "interactions",
    name: "Interactions",
  })
    .instructions(exampleInstructions, ...notesParts.instructions, ...askUser.instructions)
    .tools(...notesParts.tools, ...askUser.tools)
    .build();
  return agent;
}
