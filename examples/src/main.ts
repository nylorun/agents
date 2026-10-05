import { createClient } from "@nylorun/agents";
import { agents } from "../agents/index.js";

// Saves each agent's definition to the Runtime, which runs it; nothing here keeps running.
// The client finds the Runtime through the Project link, or NYLORUN_RUNTIME_URL and
// NYLORUN_SERVER_KEY.
const client = await createClient();
for (const agent of agents) {
  await client.saveAgent(agent);
  console.log(`Saved agent ${agent.id}`);
}
