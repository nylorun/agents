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
// `npm run dev` passes --dev: an Agent made from an older version is made again from the new one,
// so new sessions run your edit (sessions already open keep the version they pinned). Elsewhere an
// Agent keeps the version it was made from, and a newer one reaches it through a fork.
const dev = process.argv.includes("--dev");
for (const agent of agents) {
  const { manifest } = await client.agentManifests.save({ agent, runtime });
  let made = await client.agents.put(agent.id, { manifest: agent.id });
  if (dev && made.resolvedVersion < manifest.version) {
    await client.agents.delete(agent.id);
    made = await client.agents.put(agent.id, { manifest: agent.id });
  }
  console.log(`Saved agent ${agent.id} v${manifest.version} (Agent ${made.id} runs v${made.resolvedVersion})`);
}
