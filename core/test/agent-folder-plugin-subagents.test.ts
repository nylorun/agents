import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";
import { AgentManifestV8Schema } from "../src/contracts.js";

/** An Agent Plugin's `agents/*.md` are subagents of the agent that installs it, in agent-folder/4. */

const encoder = new TextEncoder();

function compile(files: Record<string, string | Uint8Array | undefined>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    const data = typeof content === "string" ? encoder.encode(content) : content;
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  const text = new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!]));
  return compileAgentFolder({ entries, files: text });
}

const errors = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "error");
const md = (front: string, body = "") => `---\n${front}---\n${body}`;
const tool = (name: string) => JSON.stringify({ description: `The ${name} tool.`, inputSchema: { type: "object" }, http: { url: `https://tools.example.com/${name}` } });
type Tool = { name: string; description?: string; agent?: Record<string, unknown>; plugin?: { name: string; version?: string } };
const toolsOf = (manifest: unknown): Tool[] => (manifest as { harness: { tools?: Tool[] } }).harness.tools ?? [];
const toolOf = (manifest: unknown, name: string) => toolsOf(manifest).find((item) => item.name === name);

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const ROOT = (format: number) =>
  md(`name: bot\ndescription: A bot.\nformat: agent-folder/${format}\nplugins: [nylorun-memory, nylorun-plan, nylorun-artifacts, nylorun-sandbox]\n`, "Help the person.\n");
const LIBRARY = {
  "runtime.json": JSON.stringify({ kind: "virtual" }),
  "tools/search_work.json": tool("search_work"),
  "tools/get_task.json": tool("get_task"),
  "mcp.json": JSON.stringify({ mcpServers: { wiki: { type: "streamable-http", url: "https://wiki.example.com/mcp" } } }),
};
const REVIEWER = md("name: reviewer\ndescription: Reviews a document.\nlicense: Apache-2.0\n", "Review it with fresh eyes.\n");
const PLUGIN = {
  "plugins/review/plugin.json": JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "review", version: "1.2.0" }),
  "plugins/review/skills/checklist/SKILL.md": md("name: checklist\ndescription: A review checklist.\n", "Check each item.\n"),
};

describe("a plugin's subagents", () => {
  it("compile to the entry the same file compiles to in the folder's own agents/, plus the plugin's label", () => {
    const own = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...PLUGIN, "agents/reviewer.md": REVIEWER });
    const plugin = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...PLUGIN, "plugins/review/agents/reviewer.md": REVIEWER });
    expect(errors(own.diagnostics)).toEqual([]);
    expect(errors(plugin.diagnostics)).toEqual([]);
    const { plugin: label, ...entry } = toolOf(plugin.manifest, "reviewer")!;
    expect(label).toEqual({ name: "review", version: "1.2.0" });
    expect(toolOf(own.manifest, "reviewer")!.plugin).toBeUndefined();
    expect(entry).toEqual(toolOf(own.manifest, "reviewer"));
    // It inherits the library, its own plugin's skill included, as the folder's own file does.
    expect(Object.keys(entry.agent!.skills as object)).toEqual(["checklist"]);
    expect(Object.keys(entry.agent!.mcpServers as object)).toEqual(["wiki"]);
    expect(plugin.diagnostics.filter((item) => item.code === "plugin_part_ignored")).toEqual([]);
  });

  it("are named by their frontmatter name, not their file name", () => {
    const result = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...PLUGIN, "plugins/review/agents/design_critic.md": md("name: review-design\ndescription: Critiques a design.\n", "Critique.\n") });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(toolOf(result.manifest, "review-design")).toBeDefined();
    expect(toolOf(result.manifest, "design_critic")).toBeUndefined();
  });

  it("narrow with the folder's keys, and report a problem at their own path in the plugin", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      ...PLUGIN,
      "plugins/review/agents/reader.md": md("name: reader\ndescription: Reads.\nreadonly: true\n", "Read.\n"),
      "plugins/review/agents/searcher.md": md("name: searcher\ndescription: Searches.\ntools: [search_work]\nskills: []\nmcpServers: {}\n", "Search.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const reader = toolOf(result.manifest, "reader")!.agent!;
    expect(reader.tools).toBeUndefined();
    expect((reader.engine as { plugins: { name: string; tools: string[] }[] }).plugins).toMatchObject([{ name: "nylorun-sandbox", tools: ["read", "grep", "glob"] }]);
    const searcher = toolOf(result.manifest, "searcher")!.agent!;
    expect((searcher.tools as { name: string }[]).map((item) => item.name)).toEqual(["search_work"]);
    expect(searcher.skills).toBeUndefined();
    expect(searcher.mcpServers).toBeUndefined();

    const typo = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...PLUGIN, "plugins/review/agents/searcher.md": md("name: searcher\ndescription: Searches.\ntools: [get_tsak]\n", "Search.\n") });
    expect(errors(typo.diagnostics)).toEqual([
      expect.objectContaining({ code: "library_unknown", file: "plugins/review/agents/searcher.md", line: 4, message: expect.stringContaining("Did you mean 'get_task'?") }),
    ]);
  });

  it("may be driven by a flow file beside them, naming the library's tools", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      ...PLUGIN,
      "plugins/review/agents/writer.md": md("name: writer\ndescription: Writes.\n", "Write.\n"),
      "plugins/review/agents/publish.md": md("name: publish\ndescription: Writes, then files it.\nflow: ./publish.flow.json\n"),
      "plugins/review/agents/publish.flow.json": JSON.stringify({ chain: [{ agent: "writer" }, { tool: "get_task" }] }),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const publish = toolOf(result.manifest, "publish")!;
    expect(publish.agent!.kind).toBe("workflow");
    expect(publish.plugin).toEqual({ name: "review", version: "1.2.0" });
    expect(result.diagnostics.filter((item) => item.code === "plugin_part_ignored")).toEqual([]);
  });

  it("never inherit one another: one tool each, one level deep", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      ...PLUGIN,
      "agents/history.md": md("name: history\ndescription: Searches past work.\n", "Search.\n"),
      "plugins/review/agents/reviewer.md": REVIEWER,
      "plugins/review/agents/critic.md": md("name: critic\ndescription: Critiques.\n", "Critique.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const subagents = toolsOf(result.manifest).filter((item) => item.agent !== undefined);
    expect(subagents.map((item) => item.name).sort()).toEqual(["critic", "history", "reviewer"]);
    for (const subagent of subagents) expect(((subagent.agent!.tools ?? []) as Tool[]).filter((item) => item.agent !== undefined)).toEqual([]);
    expect(result.diagnostics.filter((item) => item.code === "subagent_depth")).toEqual([]);
  });

  it("refuse a name already taken, naming both files", () => {
    const own = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...PLUGIN, "agents/reviewer.md": REVIEWER, "plugins/review/agents/reviewer.md": REVIEWER });
    expect(errors(own.diagnostics)).toEqual([
      expect.objectContaining({ code: "plugin_duplicate", file: "plugins/review/agents/reviewer.md", message: expect.stringContaining("agents/reviewer.md") }),
    ]);
    const asTool = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...PLUGIN, "plugins/review/agents/search.md": md("name: search_work\ndescription: Searches.\n", "Search.\n") });
    expect(errors(asTool.diagnostics)).toEqual([
      expect.objectContaining({ code: "plugin_duplicate", file: "plugins/review/agents/search.md", message: expect.stringContaining("tools/search_work.json") }),
    ]);
    const twoOwn = compile({ "AGENT.md": ROOT(4), ...LIBRARY, "agents/a.md": REVIEWER, "agents/b.md": REVIEWER });
    expect(errors(twoOwn.diagnostics)).toEqual([expect.objectContaining({ code: "tool_twice", message: expect.stringMatching(/agents\/a\.md.*agents\/b\.md|agents\/b\.md.*agents\/a\.md/) })]);
  });

  it("are a note naming the migration in agent-folder/3", () => {
    const result = compile({ "AGENT.md": ROOT(3), ...LIBRARY, ...PLUGIN, "plugins/review/agents/reviewer.md": REVIEWER });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(toolOf(result.manifest, "reviewer")).toBeUndefined();
    expect(result.diagnostics.filter((item) => item.code === "plugin_part_ignored")).toEqual([
      expect.objectContaining({ severity: "note", file: "plugins/review/agents/", message: expect.stringContaining("--to 4") }),
    ]);
  });

  it("leave a manifest whose plugins hold none unchanged", () => {
    const files = { "AGENT.md": ROOT(4), ...LIBRARY, ...PLUGIN, "agents/history.md": md("name: history\ndescription: Searches past work.\n", "Search.\n") };
    const result = compile(files);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(toolsOf(result.manifest).every((item) => item.plugin === undefined)).toBe(true);
  });
});

describe("the Elephant-Goldfish Model's personas", () => {
  const root = fileURLToPath(new URL("./support/egm-plugin/", import.meta.url));
  const egm: Record<string, Uint8Array> = { "plugins/egm/plugin.json": readFileSync(`${root}plugin.json`) };
  for (const file of readdirSync(`${root}agents`)) egm[`plugins/egm/agents/${file}`] = readFileSync(`${root}agents/${file}`);

  it("compile, as published, to ten subagents named as EGM's skills call them, each labelled egm 0.1.1", () => {
    const result = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...egm });
    expect(errors(result.diagnostics)).toEqual([]);
    const subagents = toolsOf(result.manifest).filter((item) => item.plugin?.name === "egm");
    expect(subagents.map((item) => item.name).sort()).toEqual([
      "egm-bootstrap-orchestrator",
      "egm-codebase-details",
      "egm-comprehension",
      "egm-design",
      "egm-implementation-readiness",
      "egm-inventive-catalyst",
      "egm-structural",
      "egm-style",
      "egm-synthesizer",
      "egm-zoom-out",
    ]);
    for (const subagent of subagents) expect(subagent.plugin).toEqual({ name: "egm", version: "0.1.1" });
    expect(toolOf(result.manifest, "egm-design")!.description).toContain("Design Critic");
  });

  it("make a manifest the Runtime accepts, which takes a label only on an agent used as a tool", () => {
    const result = compile({ "AGENT.md": ROOT(4), ...LIBRARY, ...egm });
    expect(AgentManifestV8Schema.safeParse(result.manifest).success).toBe(true);
    const manifest = structuredClone(result.manifest) as { harness: { tools: Tool[] } };
    manifest.harness.tools.find((item) => item.name === "search_work")!.plugin = { name: "egm" };
    expect(AgentManifestV8Schema.safeParse(manifest).success).toBe(false);
  });
});
