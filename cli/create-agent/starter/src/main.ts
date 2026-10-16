import { readFile } from "node:fs/promises";
import { createClient } from "@nylorun/agents";
import { agents } from "../agents/index.js";

// Saves each agent as an agent manifest, with the runtime it runs in, and makes the Agent its
// sessions run on (named after it); nothing here keeps running. The client finds the Runtime
// through the Project link, or NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY.
const client = await createClient();
// The runtime section the agents share: a virtual workspace with no network.
const { $schema: _, ...runtime } = JSON.parse(
  await readFile(new URL("../runtime/scratch.runtime.json", import.meta.url), "utf8"),
);
// The Agent tracks its manifest: each save moves it to the new version in place, with its disk,
// vault and sessions, and each session's next turn runs your edit (a turn already running ends on
// its version).
for (const agent of agents) {
  const { manifest } = await client.agentManifests.save({ agent, runtime });
  const made = await client.agents.put(agent.id, { manifest: agent.id });
  console.log(`Saved agent ${agent.id} v${manifest.version} (Agent ${made.id} runs v${made.resolvedVersion})`);
}
