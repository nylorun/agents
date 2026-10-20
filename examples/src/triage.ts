import { createClient } from "@nylorun/agents";
import { applyTriage } from "../agents/triage/apply.js";

// `npm run triage`: saves the agent folder agents/triage/ and makes its Agent. With
// GITHUB_TOKEN set (in .env), writes it into the Agent's vault, as
// `npx nylorun agents secrets put triage GITHUB_TOKEN` does with the value on standard input.
const client = await createClient();
const token = process.env.GITHUB_TOKEN;
const { manifest, agent, notes } = await applyTriage(client, token ? { token } : {});
for (const note of notes) console.warn(`note: ${note}`);
console.log(`Saved agent ${manifest.name} v${manifest.version} (Agent ${agent.id} runs v${agent.resolvedVersion})`);
