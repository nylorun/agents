import { Agent } from "@nylorun/agents";

/**
 * A plain agent. Its computer (bash, read, write, edit, grep and glob on a persistent
 * workspace) comes from the runtime section it is saved with: `src/main.ts` saves it with a
 * virtual one and makes the Agent `analyst`. One per person is another Agent of the same
 * manifest: `client.agents.put("users/alice/analyst", { manifest: "analyst", owner: "alice" })`,
 * then `createSession({ agent: "users/alice/analyst", ownerUserId: "alice" })`. The agent
 * declares nothing.
 */
export const analyst = Agent({ id: "analyst", name: "Data analyst" })
  .instructions(
    "Analyse data the user gives you. Save it in the sandbox's working directory, then run commands there to compute answers. Show the numbers you computed.",
  )
  .build();
