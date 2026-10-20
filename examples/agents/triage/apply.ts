import { join } from "node:path";
import { packFolder, type AgentsClient } from "@nylorun/agents";
import { EXAMPLES_ROOT } from "../shared/root.js";

/**
 * An agent folder, not TypeScript (track T6): `AGENT.md` holds the agent's name, description and
 * instructions, and `mcp.json` GitHub's MCP server, whose `Authorization: Bearer ${GITHUB_TOKEN}`
 * header names the `GITHUB_TOKEN` bearer slot the compiler derives for that server's exact URL.
 */
export const TRIAGE_FOLDER = join(EXAMPLES_ROOT, "agents/triage");

/**
 * Saves the folder, which the Runtime compiles and keeps as the version's source, and makes the
 * Agent `triage` from it (`npm run triage`; `npx nylorun apply agents/triage` saves the same
 * folder). A folder that does not compile is refused before anything is sent, naming each
 * problem by file, line and column. `token`, when given, is written into the Agent's
 * `GITHUB_TOKEN` slot.
 */
export async function applyTriage(client: AgentsClient, options: { token?: string } = {}) {
  const folder = await packFolder(TRIAGE_FOLDER);
  const { manifest, diagnostics } = await client.agentManifests.saveFolder(folder);
  const agent = await client.agents.put("triage", { manifest: manifest.name });
  if (options.token) await client.agents.secrets.put(agent.id, "GITHUB_TOKEN", { value: options.token });
  return { manifest, agent, notes: (diagnostics ?? []).map((item) => item.message) };
}
