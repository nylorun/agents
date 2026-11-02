/**
 * The Runtime's primitives as its own Agent Plugins (ADR-105, D84): an `agent-folder/3` folder
 * declares them by name under `plugins:`, they compile to the `agent-folder/2` declarations they
 * stand for plus `harness.engine.plugins`, and the engine presents their tools as server
 * `nylorun`, each keeping its effect.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";
import {
  DEFAULT_ENGINE_TOOL_LIMITS,
  MEMORY_DATA_RULE,
  PLUGIN_NAMES,
  RUNTIME_SERVER_HEADING,
  engineProjection,
  pluginOf,
  pluginTools,
  previewTurn,
  runtimeToolOf,
} from "../src/engine/index.js";
import { withoutTools } from "../src/define.js";
import { AgentManifestV8Schema } from "../src/contracts.js";
import type { AgentManifest } from "../src/types/manifest.js";

const core = join(dirname(fileURLToPath(import.meta.url)), "..");
const encoder = new TextEncoder();

function compile(files: Record<string, string>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  return compileAgentFolder({ entries, files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])) });
}
const codes = (diagnostics: readonly AgentFolderDiagnostic[], severity: AgentFolderDiagnostic["severity"] = "error") =>
  diagnostics.filter((item) => item.severity === severity).map((item) => item.code);
const agent = (front: string, body = "Help.") => `---\nname: helper\ndescription: Helps.\nformat: agent-folder/3\n${front}---\n${body}\n`;
const ALL = `plugins: [${PLUGIN_NAMES.join(", ")}]\n`;
const POD = JSON.stringify({ kind: "virtual", network: { allowedHosts: ["pypi.org", "github.com"] } });
const harnessOf = (manifest: unknown) => (manifest as { harness: Record<string, any> }).harness;

describe("the plugin bundle", () => {
  it("is generated from core/plugins and fresh", () => {
    execFileSync(process.execPath, [join(core, "scripts", "build-plugins.mjs"), "--check"]);
  });

  it("lists each plugin's tools as the engine defines them, with their effects", () => {
    const declared = PLUGIN_NAMES.map((name) => ({ name, tools: pluginTools(name), sha256: pluginOf(name).sha256 }));
    const projection = engineProjection(
      { engine: { plugins: declared, artifacts: { read: true, save: true }, sandbox: ["bash", "read", "write", "edit", "grep", "glob"] } },
      { sandbox: { workspace: "/workspace" } },
      DEFAULT_ENGINE_TOOL_LIMITS,
      { access: "read_write", root: true },
      true,
      true,
      true,
      true,
    );
    const engineTools = projection.tools.filter((tool) => tool.effectName !== undefined);
    for (const name of PLUGIN_NAMES)
      for (const { name: tool, effect } of pluginOf(name).tools) {
        const found = engineTools.find((item) => item.effectName === tool);
        expect(found, `${name}'s ${tool}`).toBeDefined();
        expect(found!.name).toBe(`nylorun__${tool}`);
        expect(found!.target?.kind).toBe(effect);
      }
    expect(engineTools).toHaveLength(PLUGIN_NAMES.flatMap(pluginTools).length);
  });

  it("keeps the memory rule that outside text is data, verbatim", () => {
    expect(pluginOf("nylorun-memory").instructions.memory).toContain(MEMORY_DATA_RULE);
    for (const name of PLUGIN_NAMES) {
      const manifest = JSON.parse(readFileSync(join(core, "plugins", name, "plugin.json"), "utf8"));
      expect(manifest.name).toBe(name);
      expect(JSON.parse(readFileSync(join(core, "plugins", name, "mcp.json"), "utf8")).mcpServers.nylorun.type).toBe("streamable-http");
    }
  });
});

describe("agent-folder/3", () => {
  it("compiles plugins into the v2 declarations they stand for, and records them", () => {
    const result = compile({
      "AGENT.md": agent(`${ALL}mcpServers:\n  nylorun:\n    tools: { save_artifact: { enabled: false } }\nengine: { outputs: true, toolSearch: false }\n`),
      "runtime.json": POD,
    });
    expect(codes(result.diagnostics)).toEqual([]);
    expect(result.compiler).toBe("agent-folder/3");
    const harness = harnessOf(result.manifest);
    expect(harness.memory).toEqual({ access: "read_write" });
    expect(harness.loop).toEqual({ plan: true, connections: true, ask: true });
    expect(harness.engine).toMatchObject({
      sandbox: ["bash", "read", "write", "edit", "grep", "glob"],
      artifacts: { read: true, save: false },
      outputs: true,
      toolSearch: false,
      triggers: true,
    });
    const plugins = harness.engine.plugins as { name: string; tools: string[]; sha256: string; hosts?: string[] }[];
    expect(plugins.map((plugin) => plugin.name)).toEqual([...PLUGIN_NAMES]);
    expect(plugins.find((plugin) => plugin.name === "nylorun-artifacts")!.tools).toEqual(["read_artifact"]);
    expect(plugins.find((plugin) => plugin.name === "nylorun-sandbox")!.hosts).toEqual(["pypi.org", "github.com"]);
    expect(plugins.every((plugin) => plugin.sha256 === pluginOf(plugin.name as never).sha256)).toBe(true);
    expect(harness.mcpServers?.nylorun).toBeUndefined();
    expect(AgentManifestV8Schema.safeParse(result.manifest).success).toBe(true);
  });

  it("refuses the keys the plugins replace, naming migrate", () => {
    const result = compile({
      "AGENT.md": agent(`${ALL}memory: { access: read_write }\nloop: { plan: true }\nengine: { sandbox: [bash], triggers: true }\n`),
      "runtime.json": JSON.stringify({ kind: "virtual", selfWake: true }),
    });
    expect(codes(result.diagnostics).filter((code) => code === "v3_refused")).toHaveLength(5);
    expect(result.diagnostics.find((item) => item.code === "v3_refused")!.message).toContain("migrate folder <dir> --to 3");
  });

  it("refuses an unknown plugin or tool, a sandbox without a computer, and plugins in v2", () => {
    expect(codes(compile({ "AGENT.md": agent("plugins: [nylorun-memroy]\n") }).diagnostics)).toContain("plugin_unknown");
    expect(codes(compile({ "AGENT.md": agent("plugins: [nylorun-sandbox]\n") }).diagnostics)).toContain("plugin_needs_computer");
    expect(
      codes(compile({ "AGENT.md": agent("plugins: [nylorun-plan]\nmcpServers:\n  nylorun:\n    tools: { memory: { enabled: false } }\n") }).diagnostics),
    ).toContain("tool_unknown");
    expect(codes(compile({ "AGENT.md": "---\nname: helper\ndescription: Helps.\nformat: agent-folder/2\nplugins: [nylorun-plan]\n---\nHelp.\n" }).diagnostics)).toContain("v3_key");
  });

  it("reserves the server nylorun and the plugins' skill names", () => {
    const server = compile({
      "AGENT.md": agent("plugins: [nylorun-plan]\n"),
      "mcp.json": JSON.stringify({ mcpServers: { nylorun: { type: "streamable-http", url: "https://example.com/mcp" } } }),
    });
    expect(codes(server.diagnostics)).toContain("server_reserved");
    const skill = compile({
      "AGENT.md": agent("plugins: [nylorun-memory]\n"),
      "skills/memory/SKILL.md": "---\nname: memory\ndescription: Mine.\n---\nKeep.\n",
    });
    expect(codes(skill.diagnostics)).toContain("skill_reserved");
  });

  it("gives a subagent a subset of its parent's plugins, and view-only memory", () => {
    const result = compile({
      "AGENT.md": agent("plugins: [nylorun-memory, nylorun-plan]\n"),
      "agents/scout/AGENT.md": "---\nname: scout\ndescription: Looks.\nplugins: [nylorun-plan]\n---\nLook.\n",
    });
    expect(codes(result.diagnostics)).toEqual([]);
    const refused = compile({
      "AGENT.md": agent("plugins: [nylorun-memory]\n"),
      "agents/scout/AGENT.md": "---\nname: scout\ndescription: Looks.\nplugins: [nylorun-plan]\n---\nLook.\n",
    });
    expect(codes(refused.diagnostics)).toContain("plugin_subset");
  });
});

describe("server nylorun, as the model sees it", () => {
  const compiled = compile({
    "AGENT.md": agent(`${ALL}engine: { outputs: true }\n`),
    "runtime.json": POD,
  });
  const preview = previewTurn(compiled.manifest!);

  it("names each tool nylorun__<tool> and keeps its effect", () => {
    const names = preview.tools.map((tool) => tool.name);
    for (const tool of ["memory", "triggers", "update_plan", "ask", "request_connection", "read_artifact", "save_artifact", "bash", "glob"])
      expect(names).toContain(`nylorun__${tool}`);
    expect(names).toContain("load_skill");
    expect(names).not.toContain("memory");
    expect(runtimeToolOf("nylorun__memory")).toBe("memory");
    expect(runtimeToolOf("nylorun__nope")).toBeUndefined();
  });

  it("puts the Runtime's words in one server text, with the plugins' skills in the catalog", () => {
    expect(preview.system).toContain(RUNTIME_SERVER_HEADING);
    expect(preview.system).toContain("## Memory");
    expect(preview.system).toContain("## Triggers");
    expect(preview.system).toContain("It can reach only these hosts: pypi.org, github.com.");
    expect(preview.system).toContain("<name>memory</name>");
    expect(preview.system).toContain("<name>triggers</name>");
    expect(preview.system).not.toMatch(/^# Memory$/m);
    expect(preview.blocks.map((block) => block.name)).toEqual(["skills", "outputs"]);
  });

  it("brings nothing of an undeclared plugin: off means off", () => {
    const only = compile({ "AGENT.md": agent("plugins: [nylorun-plan]\n") });
    const view = previewTurn(only.manifest!);
    expect(view.tools.map((tool) => tool.name)).toEqual(["nylorun__update_plan"]);
    expect(view.system).toContain("## Plan");
    expect(view.system).not.toContain("Memory");
    expect(view.system).not.toContain("load_skill");
  });

  it("lets removeTools leave a plugin's tool out by the name the model reads", () => {
    const loop = { ...(harnessOf(compiled.manifest) as object), id: "helper", manifestSchemaVersion: 7 } as unknown as AgentManifest;
    const narrowed = withoutTools(loop, ["nylorun__ask"]);
    const interactions = narrowed.engine!.plugins!.find((plugin) => plugin.name === "nylorun-interactions")!;
    expect(interactions.tools).toEqual(["request_connection"]);
    const projection = engineProjection(narrowed, undefined, DEFAULT_ENGINE_TOOL_LIMITS, undefined, true, true, false, true);
    expect(projection.tools.map((tool) => tool.name)).toContain("nylorun__request_connection");
    expect(projection.tools.map((tool) => tool.name)).not.toContain("nylorun__ask");
  });
});
