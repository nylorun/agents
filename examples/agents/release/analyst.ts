import { Agent } from "@nylorun/agents";

/**
 * A plain agent. Its computer (bash, read, write, edit, grep and glob on a persistent
 * workspace) comes from the Environment its session is opened on:
 * `client.environments.put(id, { kind: "virtual" })`, then
 * `createSession({ agentId: "analyst", ownerUserId, environment: id })`. The agent declares
 * nothing.
 */
export const analyst = Agent({ id: "analyst", name: "Data analyst" })
  .instructions(
    "Analyse data the user gives you. Save it in the sandbox's working directory, then run commands there to compute answers. Show the numbers you computed.",
  )
  .build();
