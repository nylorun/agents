/**
 * The Repo brief flow as an agent folder (track T7, design §3.8): the 23 Markdown and JSON files
 * of `agents/repo-brief-folder/` compile to the manifest the TypeScript `agents/repo-brief` saves.
 * Two differences are by design, and the comparison names them:
 *
 * - **Instructions.** A folder has one instruction string per Markdown file, wrapped as written;
 *   the engine joins them with a blank line, so the prompt is the same text (as in T6's triage).
 * - **Display names.** In a folder, an agent's `name` is its id (design §3.2), so an embedded
 *   agent has no display name ("Triage", "Brief writer") beside its id.
 *
 * And back (`folderOfManifest`, `nylorun export --folder`): the TypeScript flow's manifest writes
 * a folder that compiles to it, but for the display names, which the notes name.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { agentManifest, checkFolder, folderOfManifest, packFolder } from "@nylorun/agents";
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

/** Each embedded agent without its display name, which a folder does not keep. */
function withoutDisplayNames(manifest: Json): Json {
  const visit = (agent: Json): Json => {
    const { name: _, ...rest } = agent;
    return rest.agents ? { ...rest, agents: visitAll(rest.agents as Json) } : rest;
  };
  const visitAll = (agents: Json) => Object.fromEntries(Object.entries(agents).map(([id, item]) => [id, visit(item as Json)]));
  const harness = manifest.harness as Json;
  return { ...manifest, harness: { ...harness, agents: visitAll(harness.agents as Json) } };
}

it("writes the TypeScript flow's manifest as a folder that compiles back to it, but for the display names", async () => {
  const typescript = agentManifest({ agent: createRepoBrief({ toolsUrl: TOOLS_URL }), runtime: { kind: "virtual" } });
  // The skill's bytes, by the hashes the manifest names them by.
  const skill = join(EXAMPLES_ROOT, "agents/repo-brief/skills/repo-brief");
  const bytes = new Map<string, Uint8Array>();
  for (const path of ["SKILL.md", "scripts/check.sh"]) {
    const data = new Uint8Array(await readFile(join(skill, path)));
    bytes.set(`sha256:${createHash("sha256").update(data).digest("hex")}`, data);
  }

  const folder = folderOfManifest(typescript, { files: bytes });
  expect(folder.exact).toBe(false);
  expect(folder.notes).toEqual(
    [
      ["triage", "Triage"],
      ["research", "Research"],
      ["researcher", "Researcher"],
      ["overview", "Overview"],
      ["risks", "Risk reviewer"],
      ["writer", "Brief writer"],
      ["editor", "Editor"],
      ["decline", "Decline"],
    ].map(([id, name]) => `agents/${id}/: The agent's display name "${name}" is left out: in a folder an agent's name is its id (design §3.2).`),
  );
  expect([...folder.files.keys()]).toEqual([
    "AGENT.md",
    "agents/decline/AGENT.md",
    "agents/editor/AGENT.md",
    "agents/editor/output.schema.json",
    "agents/overview/AGENT.md",
    "agents/overview/output.schema.json",
    "agents/research/AGENT.md",
    "agents/research/flow.json",
    "agents/research/tools/publish_brief.json",
    "agents/researcher/AGENT.md",
    "agents/researcher/mcp.json",
    "agents/researcher/output.schema.json",
    "agents/risks/AGENT.md",
    "agents/risks/output.schema.json",
    "agents/triage/AGENT.md",
    "agents/triage/output.schema.json",
    "agents/writer/AGENT.md",
    "agents/writer/output.schema.json",
    "agents/writer/skills/repo-brief/SKILL.md",
    "agents/writer/skills/repo-brief/scripts/check.sh",
    "agents/writer/tools/now.json",
    "flow.json",
    "runtime.json",
  ]);

  // Written to disk and packed as nylorun apply packs it, it compiles to the manifest without them.
  const root = await mkdtemp(join(tmpdir(), "repo-brief-export-"));
  try {
    for (const [path, content] of folder.files) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    expect((await readdir(root)).sort()).toEqual(["AGENT.md", "agents", "flow.json", "runtime.json"]);
    const compiled = await checkFolder(await packFolder(root), { name: "repo-brief" });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.manifest).toEqual(withoutDisplayNames(typescript as unknown as Json));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  // Without the display names, the round trip is exact.
  const plain = folderOfManifest(withoutDisplayNames(typescript as unknown as Json) as unknown as typeof typescript, { files: bytes });
  expect(plain.notes).toEqual([]);
  expect(plain.exact).toBe(true);
});
