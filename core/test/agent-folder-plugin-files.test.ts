import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";
import { AgentManifestV8Schema } from "../src/contracts.js";
import { definitionFilesOf, mountedPluginsOf, pluginFolderOf } from "../src/utils/definition-files.js";
import { loopManifestOf } from "../src/definition/sections.js";

/** An Agent Plugin holding files beyond its parts carries them all, mounted at /plugins/<name>@<hash>/. */

const encoder = new TextEncoder();
const hex = (data: Uint8Array) => bytesToHex(sha256(data));

function compile(files: Record<string, string | Uint8Array>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    entries.push({ path, size: data.byteLength, sha256: hex(data) });
    bytes.set(path, data);
  }
  const text = new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!]));
  return compileAgentFolder({ entries, files: text });
}

const errors = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "error");
const md = (front: string, body = "") => `---\n${front}---\n${body}`;
type Plugin = { name: string; version?: string; files?: Record<string, string> };
const pluginsOf = (manifest: unknown) => ((manifest as { harness: { plugins?: Plugin[] } }).harness.plugins ?? []);
const ROOT = (format: number) => md(`name: bot\ndescription: A bot.\nformat: agent-folder/${format}\nplugins: [nylorun-sandbox]\n`, "Help.\n");
const RUNTIME = { "runtime.json": JSON.stringify({ kind: "virtual" }) };
const SKILL = md("name: checklist\ndescription: A review checklist.\n", "Read resources/standard.md.\n");

/** Every file of a folder on disk, by path. */
function folder(root: string, prefix: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${rel}${name}/`);
      else out[`${prefix}${rel}${name}`] = readFileSync(path);
    }
  };
  walk(root, "");
  return out;
}

describe("a plugin's files", () => {
  it("are carried whole, by hash, when the plugin holds files beyond its parts, and none otherwise", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...RUNTIME,
      "plugins/review/plugin.json": JSON.stringify({ name: "review", version: "1.0.0" }),
      "plugins/review/skills/checklist/SKILL.md": SKILL,
      "plugins/review/resources/standard.md": "# The standard\n",
      "plugins/review/.env": "TOKEN=x\n",
      "plugins/review/key.pem": "-----BEGIN-----\n",
      "plugins/plain/plugin.json": JSON.stringify({ name: "plain" }),
      "plugins/plain/skills/notes/SKILL.md": md("name: notes\ndescription: Notes.\n", "Notes.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const [plain, review] = pluginsOf(result.manifest);
    expect(plain).toEqual({ name: "plain" });
    expect(review!.name).toBe("review");
    expect(Object.keys(review!.files!)).toEqual(["plugin.json", "resources/standard.md", "skills/checklist/SKILL.md"]);
    expect(review!.files!["resources/standard.md"]).toBe(`sha256:${hex(encoder.encode("# The standard\n"))}`);
    expect(AgentManifestV8Schema.safeParse(result.manifest).success).toBe(true);
  });

  it("go to the manifest the harness runs, for the root and each subagent, and name their definition files", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...RUNTIME,
      "agents/history.md": md("name: history\ndescription: Searches.\n", "Search.\n"),
      "plugins/review/plugin.json": JSON.stringify({ name: "review" }),
      "plugins/review/skills/checklist/SKILL.md": SKILL,
      "plugins/review/resources/standard.md": "# The standard\n",
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const loop = loopManifestOf(result.manifest as never) as { plugins?: Plugin[]; tools?: { agent?: { plugins?: Plugin[] } }[] };
    const mounted = loop.plugins!;
    expect(mounted.map((plugin) => plugin.name)).toEqual(["review"]);
    expect(loop.tools!.find((tool) => tool.agent)!.agent!.plugins).toEqual(mounted);
    expect([...definitionFilesOf(loop)]).toContain(`sha256:${hex(encoder.encode("# The standard\n"))}`);
    expect([...mountedPluginsOf(loop)]).toHaveLength(2);
    expect(pluginFolderOf(mounted[0] as { name: string; files: Record<string, string> })).toMatch(/^\/plugins\/review@[0-9a-f]{12}$/);
  });

  it("leave a manifest whose plugins hold only their parts as it was", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...RUNTIME,
      "plugins/plain/plugin.json": JSON.stringify({ name: "plain" }),
      "plugins/plain/skills/notes/SKILL.md": md("name: notes\ndescription: Notes.\n", "Notes.\n"),
      "plugins/plain/agents/helper.md": md("name: helper\ndescription: Helps.\n", "Help.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(pluginsOf(result.manifest)).toEqual([{ name: "plain" }]);
    expect((loopManifestOf(result.manifest as never) as { plugins?: unknown }).plugins).toBeUndefined();
  });

  it("mount EGM as published: its personas and standards, with its subagents read from the same files", () => {
    const root = fileURLToPath(new URL("./support/egm-plugin/", import.meta.url));
    const result = compile({ "AGENT.md": ROOT(4), ...RUNTIME, ...folder(root, "plugins/egm/") });
    expect(errors(result.diagnostics)).toEqual([]);
    const egm = pluginsOf(result.manifest).find((plugin) => plugin.name === "egm")!;
    expect(Object.keys(egm.files!)).toEqual(
      expect.arrayContaining(["plugin.json", "LICENSE", "agents/design_critic.md", "resources/document_standards/feature-spec-standard.md"]),
    );
    expect(result.diagnostics.filter((item) => item.code === "plugin_part_ignored" && item.file?.startsWith("plugins/egm/agents"))).toEqual([]);
  });
});
