/**
 * The Repo brief flow as an agent folder (track T7, design §3.8): the 23 Markdown and JSON files
 * of `agents/repo-brief-folder/` compile to the manifest the TypeScript `agents/repo-brief` saves.
 * Two differences are by design, and the comparison names them:
 *
 * - **Instructions.** A folder has one instruction string per Markdown file, wrapped as written;
 *   the engine joins them with a blank line, so the prompt is the same text (as in T6's triage).
 * - **Display names.** In a folder, an agent's `name` is its id (design §3.2), so an embedded
 *   agent has no display name ("Triage", "Brief writer") beside its id.
 */
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentManifest, checkFolder, packFolder } from "@nylorun/agents";
import { createRepoBrief } from "../agents/repo-brief/agent.js";
import { DEEPWIKI_MCP_URL } from "../agents/mcp/agent.js";
import { EXAMPLES_ROOT } from "../agents/shared/root.js";

const FOLDER = join(EXAMPLES_ROOT, "agents/repo-brief-folder");
/** Where the folder's tools call the examples' tools service: TOOLS_URL's default. */
const TOOLS_URL = "http://localhost:3001";

type Json = Record<string, unknown>;

/** Each agent's instructions as the one prompt the engine builds, and no display names. */
function prompted(manifest: Json): Json {
  const visit = (agent: Json, embedded: boolean): Json => {
    const { name: _, ...rest } = agent;
    const out: Json = embedded ? rest : { ...agent };
    if (Array.isArray(out.instructions))
      out.instructions = [(out.instructions as string[]).join("\n\n").replace(/(?<!\n)\n(?!\n)/g, " ")];
    if (out.agents) out.agents = Object.fromEntries(Object.entries(out.agents as Json).map(([id, item]) => [id, visit(item as Json, true)]));
    return out;
  };
  return { ...manifest, harness: visit(manifest.harness as Json, false) };
}

it("compiles the folder to the manifest the TypeScript flow saves", async () => {
  const folder = await packFolder(FOLDER);
  expect(folder.entries).toHaveLength(23);
  const compiled = await checkFolder(folder);
  expect(compiled.diagnostics).toEqual([]);
  const typescript = agentManifest({
    agent: createRepoBrief({ toolsUrl: TOOLS_URL, mcpUrl: DEEPWIKI_MCP_URL }),
    runtime: { kind: "virtual" },
  });
  expect(prompted(compiled.manifest as unknown as Json)).toEqual(prompted(typescript as unknown as Json));
  // The folder's sub-flow embeds its own agents, as v3 nests them: the author wrote one flat agents/.
  const harness = compiled.manifest!.harness as { agents: Record<string, { agents?: Json }> };
  expect(Object.keys(harness.agents)).toEqual(["triage", "research", "decline"]);
  expect(Object.keys(harness.agents.research!.agents!)).toEqual(["researcher", "overview", "risks", "writer", "editor"]);
});
