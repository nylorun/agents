import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";
import {
  ENGINE_BLOCK_VERSIONS,
  MEMORY_DATA_RULE,
  blockHash,
  engineFeaturesOf,
  mcpToolSet,
  DEFAULT_MCP_TOOL_CONFIG,
  previewTurn,
} from "../src/engine/index.js";
import { loopManifestOf } from "../src/definition/sections.js";
import type { AgentManifest } from "../src/types/manifest.js";

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

const agent = (front: string, body = "Help.") => `---\nname: helper\ndescription: Helps.\n${front}---\n${body}\n`;
const COMPUTER = JSON.stringify({ kind: "virtual" });

describe("agent-folder/2 (ADR-100)", () => {
  it("keeps agent-folder/1, and a folder with no format, exactly as before", () => {
    const none = compile({ "AGENT.md": agent(""), "runtime.json": COMPUTER });
    const one = compile({ "AGENT.md": agent("format: agent-folder/1\n"), "runtime.json": COMPUTER });
    expect(none.compiler).toBe("agent-folder/1");
    expect(one.compiler).toBe("agent-folder/1");
    expect(none.manifest!.harness).not.toHaveProperty("engine");
    expect(one.manifest).toEqual(none.manifest);
  });

  it("refuses engine and memory.index under agent-folder/1, naming migrate folder", () => {
    const compiled = compile({ "AGENT.md": agent("engine:\n  outputs: true\nmemory:\n  index: false\n"), "runtime.json": COMPUTER });
    expect(codes(compiled.diagnostics)).toEqual(["engine_format", "engine_format"]);
    expect(compiled.diagnostics[0]!.message).toContain("nylorun migrate folder");
  });

  it("compiles the declarations into harness.engine, with the blocks the agent gets and their hashes", () => {
    const compiled = compile({
      "AGENT.md": agent(
        "format: agent-folder/2\nmemory:\n  access: read_write\nengine:\n  sandbox: [read, bash]\n  artifacts: { read: true, save: false }\n  outputs: true\n  toolSearch: false\n",
      ),
      "runtime.json": COMPUTER,
    });
    expect(codes(compiled.diagnostics)).toEqual([]);
    expect(compiled.compiler).toBe("agent-folder/2");
    const engine = (compiled.manifest!.harness as { engine?: unknown }).engine;
    expect(engine).toEqual({
      sandbox: ["bash", "read"],
      artifacts: { read: true, save: false },
      outputs: true,
      toolSearch: false,
      blocks: ["sandbox", "outputs", "artifacts_read", "memory"].map((name) => ({
        name,
        version: ENGINE_BLOCK_VERSIONS[name as keyof typeof ENGINE_BLOCK_VERSIONS],
        sha256: blockHash(name as never),
      })),
    });
    // The loop manifest the harness runs carries them.
    expect((loopManifestOf(compiled.manifest!) as AgentManifest).engine).toEqual(engine);
  });

  it("needs a computer for the sandbox tools, save_artifact and the outputs folder, and warns of a computer with no sandbox tools", () => {
    const without = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  sandbox: [bash]\n  artifacts: { save: true }\n  outputs: true\n"),
    });
    expect(codes(without.diagnostics)).toEqual(["engine_needs_computer", "engine_needs_computer", "engine_needs_computer"]);
    const bare = compile({ "AGENT.md": agent("format: 2\n"), "runtime.json": COMPUTER });
    expect(codes(bare.diagnostics)).toEqual([]);
    expect(codes(bare.diagnostics, "warning")).toEqual(["sandbox_undeclared"]);
    expect((bare.manifest!.harness as { engine?: unknown }).engine).toEqual({ blocks: [] });
  });

  it("refuses an unknown engine key, sandbox tool or block", () => {
    const compiled = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  sandbx: [bash]\n  sandbox: [bsh]\n  instructions:\n    memry: engine/memory.md\n"),
      "runtime.json": COMPUTER,
    });
    expect(codes(compiled.diagnostics)).toEqual(["unknown_key", "value_invalid", "unknown_key"]);
    expect(compiled.diagnostics.map((item) => item.message).join("\n")).toContain("Did you mean 'sandbox'?");
  });

  it("replaces a block's wording from engine/, keeping the memory rule that outside text is data", () => {
    const compiled = compile({
      "AGENT.md": agent("format: agent-folder/2\nmemory: {}\nengine:\n  instructions:\n    memory: engine/memory.md\n"),
      "engine/memory.md": "\n# What to remember\nOnly the person's preferences.\n",
    });
    expect(codes(compiled.diagnostics)).toEqual([]);
    const engine = (compiled.manifest!.harness as { engine: { instructions: unknown; blocks: unknown } }).engine;
    expect(engine.instructions).toEqual({ memory: "# What to remember\nOnly the person's preferences." });
    expect(engine.blocks).toEqual([
      {
        name: "memory",
        version: ENGINE_BLOCK_VERSIONS.memory,
        sha256: blockHash("memory", "# What to remember\nOnly the person's preferences."),
        source: "engine/memory.md",
      },
    ]);
    const { system } = previewTurn(compiled.manifest!);
    expect(system).toContain("# What to remember\nOnly the person's preferences.\n" + MEMORY_DATA_RULE);
    expect(system).not.toContain("You have a persistent memory directory");
  });

  it("refuses a block's wording outside engine/, and warns of one for a block the agent does not get", () => {
    const outside = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  instructions:\n    memory: notes/memory.md\n"),
      "notes/memory.md": "x",
    });
    expect(codes(outside.diagnostics)).toEqual(["value_invalid"]);
    const unused = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  instructions:\n    memory: engine/memory.md\n"),
      "engine/memory.md": "x",
    });
    expect(codes(unused.diagnostics, "warning")).toEqual(["engine_text_unused"]);
  });

  it("notes an engine/ file under agent-folder/1 as before: kept, not compiled", () => {
    const compiled = compile({ "AGENT.md": agent(""), "engine/x.md": "x" });
    expect(compiled.diagnostics.filter((item) => item.file === "engine/x.md").map((item) => item.code)).toEqual(["file_not_compiled"]);
  });

  it("gives a subagent only its own engine block, a subset of its parent's", () => {
    const sub = (front: string) => `---\nname: scout\ndescription: Looks around.\n${front}---\nLook.\n`;
    const parent = "format: agent-folder/2\nengine:\n  sandbox: [bash, read]\n  artifacts: { read: true }\n";
    const ok = compile({
      "AGENT.md": agent(parent),
      "runtime.json": COMPUTER,
      "agents/scout/AGENT.md": sub("engine:\n  sandbox: [read]\n"),
      "agents/plain/AGENT.md": `---\nname: plain\ndescription: Plain.\n---\nPlain.\n`,
    });
    expect(codes(ok.diagnostics)).toEqual([]);
    const tools = (ok.manifest!.harness as { tools: { name: string; agent: AgentManifest }[] }).tools;
    expect(tools.find((tool) => tool.name === "scout")!.agent.engine).toMatchObject({ sandbox: ["read"] });
    expect(tools.find((tool) => tool.name === "plain")!.agent.engine).toEqual({ blocks: [] });
    const preview = previewTurn(ok.manifest!);
    expect(preview.agents.scout!.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(preview.agents.plain!.tools).toEqual([]);
    const wider = compile({
      "AGENT.md": agent(parent),
      "runtime.json": COMPUTER,
      "agents/scout/AGENT.md": sub("engine:\n  sandbox: [write]\n  artifacts: { save: true }\n  outputs: true\n  toolSearch: true\n"),
    });
    expect(codes(wider.diagnostics)).toEqual(["engine_subset", "engine_subset", "engine_subset", "engine_subset"]);
    expect(wider.diagnostics.every((item) => item.severity !== "error" || item.file === "agents/scout/AGENT.md")).toBe(true);
  });
});

describe("what an agent-folder/2 agent gets", () => {
  const manifest = (engine: AgentManifest["engine"], extra: Partial<AgentManifest> = {}): AgentManifest => ({
    manifestSchemaVersion: 7,
    id: "a",
    instructions: ["Help."],
    ...(engine === undefined ? {} : { engine }),
    ...extra,
  });

  it("is everything for a v1 agent, and only what it declares for a v2 one", () => {
    expect(engineFeaturesOf(undefined, { computer: true })).toMatchObject({ sandbox: ["bash", "read", "write", "edit", "grep", "glob"], artifactsRead: true, artifactsSave: true, outputs: true, toolSearch: true });
    expect(engineFeaturesOf({}, { computer: true })).toMatchObject({ sandbox: [], artifactsRead: false, artifactsSave: false, outputs: false, toolSearch: false });
    const v1 = previewTurn(manifest(undefined), { sandbox: true });
    expect(v1.tools.map((tool) => tool.name)).toEqual(["bash", "read", "write", "edit", "grep", "glob", "save_artifact", "read_artifact"]);
    const v2 = previewTurn(manifest({}), { sandbox: true });
    expect(v2.tools).toEqual([]);
    expect(v2.system).toBe("Help.");
  });

  it("migrated declarations give a v1 agent's exact text and tools", () => {
    const v1 = previewTurn(manifest(undefined), { sandbox: true, memory: { index: "- a.md" } });
    const v2 = previewTurn(
      manifest({ sandbox: ["bash", "read", "write", "edit", "grep", "glob"], artifacts: { read: true, save: true }, outputs: true, toolSearch: true }),
      { sandbox: true, memory: { index: "- a.md" } },
    );
    expect(v2.system).toBe(v1.system);
    expect(v2.tools).toEqual(v1.tools);
    expect(v2.pinned).toEqual(v1.pinned);
  });

  it("drops the index rule and the pinned index with memory.index off", () => {
    const off = previewTurn(manifest({}), { memory: { index: false } });
    expect(off.pinned).toEqual([]);
    expect(off.system).not.toContain("index of the memory files");
    expect(off.system).toContain(MEMORY_DATA_RULE);
  });

  it("never defers MCP tools automatically without toolSearch, and says so past the threshold", () => {
    const big = { type: "object", properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, { type: "string", description: "x".repeat(100) }])) };
    const facts = {
      servers: [
        {
          name: "gh",
          tools: Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, inputSchema: big, enabled: true })),
        },
      ],
    };
    const declared = mcpToolSet(facts as never, manifest({}), { config: DEFAULT_MCP_TOOL_CONFIG });
    expect(declared.tools.some((tool) => tool.deferred)).toBe(false);
    expect(declared.diagnostics.map((item) => item.code)).toEqual(["mcp_tools_inline"]);
    const searching = mcpToolSet(facts as never, manifest({ toolSearch: true }), { config: DEFAULT_MCP_TOOL_CONFIG });
    expect(searching.tools.some((tool) => tool.deferred)).toBe(true);
    expect(searching.diagnostics).toEqual([]);
    // A server's own deferred still applies.
    const own = { servers: [{ name: "gh", tools: [{ name: "t", inputSchema: { type: "object" }, enabled: true, deferred: true }] }] };
    expect(mcpToolSet(own as never, manifest({}), { config: DEFAULT_MCP_TOOL_CONFIG }).tools.map((tool) => tool.name)).toEqual([
      "tool_search",
      "tool_call",
      "gh__t",
    ]);
    // The layout reused from the state says nothing again.
    const again = mcpToolSet(facts as never, manifest({}), { config: DEFAULT_MCP_TOOL_CONFIG, layout: declared.layout });
    expect(again.diagnostics).toEqual([]);
  });
});
