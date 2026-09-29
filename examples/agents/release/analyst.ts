import { Agent } from "@nylorun/agents";

/**
 * One line gives the agent a computer: bash, read, write, edit, grep and glob on an isolated
 * Linux machine with a persistent /workspace. The Runtime picks where it runs.
 */
export const analyst = Agent({ id: "analyst", name: "Data analyst" })
  .instructions(
    "Analyse data the user gives you. Save it under /workspace, then use Python in the sandbox to compute answers. Show the numbers you computed.",
  )
  .sandbox()
  .build();
