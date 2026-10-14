import { readdir, readFile } from "node:fs/promises";
import { createClient } from "@nylorun/agents";
import { agents } from "../agents/index.js";

// Saves each agent's definition and each environment manifest to the Runtime, which runs them;
// nothing here keeps running. The client finds the Runtime through the Project link, or
// NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY.
const client = await createClient();
for (const agent of agents) {
  await client.saveAgent(agent);
  console.log(`Saved agent ${agent.id}`);
}
// An Environment is made from one version of a manifest and never changes; a new version
// reaches it through a fork.
const environments = new URL("../environments/", import.meta.url);
for (const file of (await readdir(environments)).filter((name) => name.endsWith(".json"))) {
  const manifest = JSON.parse(await readFile(new URL(file, environments), "utf8"));
  const { manifest: saved, unchanged } = await client.environments.manifests.save(manifest);
  console.log(`${unchanged ? "Unchanged" : "Saved"} environment manifest ${saved.name} v${saved.version}`);
}
