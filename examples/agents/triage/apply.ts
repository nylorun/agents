import { join } from "node:path";
import { composeManifest, type AgentsClient } from "@nylorun/agents";
import { EXAMPLES_ROOT } from "../shared/root.js";

/**
 * An agent authored as three files, not TypeScript: `agent.manifest.json` names the manifest
 * and its two sections by path, `harness.manifest.json` holds what runs in the loop (its
 * instructions, and GitHub's MCP server with the `credentials` slot it authenticates with), and
 * `platform/virtual.runtime.json` the runtime other agents may share (a virtual workspace, and
 * the `GITHUB_TOKEN` bearer slot bound to that server's exact URL).
 */
export const TRIAGE_FOLDER = join(EXAMPLES_ROOT, "agents/triage");

/**
 * Composes the folder into one agent manifest, saves it, and makes the Agent `triage` from it
 * (`npm run triage`; `npx nylorun apply agents/triage` saves the same manifest). A save whose
 * sections do not fit is refused before anything is sent, naming each gap. `token`, when given,
 * is written into the Agent's `GITHUB_TOKEN` slot.
 */
export async function applyTriage(client: AgentsClient, options: { token?: string } = {}) {
  const composed = await composeManifest(TRIAGE_FOLDER);
  const { manifest } = await client.agentManifests.save(composed);
  const agent = await client.agents.put("triage", { manifest: manifest.name });
  if (options.token) await client.agents.secrets.put(agent.id, "GITHUB_TOKEN", { value: options.token });
  return { manifest, agent, warnings: composed.warnings };
}
