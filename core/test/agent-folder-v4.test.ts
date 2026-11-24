import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";

/** agent-folder/4: a subagent is one file, drawing on the manifest's library. */

const encoder = new TextEncoder();

function compile(files: Record<string, string | undefined>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    const data = encoder.encode(content);
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  const text = new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!]));
  return compileAgentFolder({ entries, files: text });
}

const errors = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "error");
const md = (front: string, body = "") => `---\n${front}---\n${body}`;
const tool = (name: string) => JSON.stringify({ description: `The ${name} tool.`, inputSchema: { type: "object" }, http: { url: `https://tools.example.com/${name}` } });
/** The manifest a subagent is embedded as (agent manifest v7), by its tool's name. */
const subagentTools = (manifest: unknown, id: string) => {
  const tools = (manifest as { harness: { tools?: { name: string; agent?: Record<string, unknown> }[] } }).harness.tools ?? [];
  return tools.find((item) => item.name === id)?.agent;
};

/** The bot's shape: a root with a computer and service tools, and three subagents. */
const ROOT = (format: number, extra = "") =>
  md(`name: bot\ndescription: A bot.\nformat: agent-folder/${format}\nplugins: [nylorun-memory, nylorun-plan, nylorun-artifacts, nylorun-sandbox]\n${extra}`, "Help the person.\n");
const LIBRARY = {
  "runtime.json": JSON.stringify({ kind: "virtual" }),
  "tools/search_work.json": tool("search_work"),
  "tools/get_task.json": tool("get_task"),
  "tools/start_task.json": tool("start_task"),
};

describe("agent-folder/4: subagent files", () => {
  it("compiles to the same manifest as an agent-folder/3 folder holding copies", () => {
    const v4 = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      "agents/reviewer.md": md("name: reviewer\ndescription: Checks a result.\ntools: []\n", "Review it.\n"),
      "agents/history.md": md("name: history\ndescription: Searches past work.\ntools: [search_work, get_task]\n", "Search.\n"),
    });
    const v3 = compile({
      "AGENT.md": ROOT(3),
      ...LIBRARY,
      "agents/reviewer/AGENT.md": md("name: reviewer\ndescription: Checks a result.\n", "Review it.\n"),
      "agents/history/AGENT.md": md("name: history\ndescription: Searches past work.\n", "Search.\n"),
      "agents/history/tools/search_work.json": tool("search_work"),
      "agents/history/tools/get_task.json": tool("get_task"),
    });
    expect(errors(v4.diagnostics)).toEqual([]);
    expect(errors(v3.diagnostics)).toEqual([]);
    expect(v4.compiler).toBe("agent-folder/4");
    expect(v4.manifest).toEqual(v3.manifest);
  });

  it("inherits the library a subagent can use: HTTP tools, the sandbox and artifacts, never the root's plan or memory", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      "agents/planner.md": md("name: planner\ndescription: Plans.\n", "Plan.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const harness = subagentTools(result.manifest, "planner")!;
    expect((harness.tools as { name: string }[]).map((item) => item.name).sort()).toEqual(["get_task", "search_work", "start_task"]);
    const plugins = ((harness.engine as { plugins: { name: string }[] }).plugins ?? []).map((plugin) => plugin.name);
    expect(plugins).toEqual(["nylorun-artifacts", "nylorun-sandbox"]);
  });

  it("narrows with tools, disallowedTools and readonly, and reads Claude Code's names", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      "agents/a.md": md("name: a\ndescription: A.\ntools: Read, Grep, search_work\nmodel: sonnet\ncolor: blue\n", "A.\n"),
      "agents/b.md": md("name: b\ndescription: B.\ndisallowedTools: [start_task, bash]\n", "B.\n"),
      "agents/c.md": md("name: c\ndescription: C.\nreadonly: true\n", "C.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const a = subagentTools(result.manifest, "a")!;
    expect((a.tools as { name: string }[]).map((item) => item.name)).toEqual(["search_work"]);
    expect((a.engine as { plugins: { name: string; tools: string[] }[] }).plugins).toMatchObject([{ name: "nylorun-sandbox", tools: ["read", "grep"] }]);
    const b = subagentTools(result.manifest, "b")!;
    expect((b.tools as { name: string }[]).map((item) => item.name).sort()).toEqual(["get_task", "search_work"]);
    expect((b.engine as { plugins: { name: string; tools: string[] }[] }).plugins.find((plugin) => plugin.name === "nylorun-sandbox")!.tools).not.toContain("bash");
    const c = subagentTools(result.manifest, "c")!;
    expect(c.tools).toBeUndefined();
    expect((c.engine as { plugins: { name: string; tools: string[] }[] }).plugins).toMatchObject([{ name: "nylorun-sandbox", tools: ["read", "grep", "glob"] }]);
    const notes = result.diagnostics.filter((item) => item.file === "agents/a.md").map((item) => item.code);
    expect(notes).toEqual(expect.arrayContaining(["tool_alias", "host_key"]));
  });

  it("reports a name the library doesn't hold on the subagent's own file and line", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      "agents/history.md": md("name: history\ndescription: Searches.\ntools: [search_work, get_tsak]\n", "Search.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "library_unknown", file: "agents/history.md", line: 4, message: expect.stringContaining("Did you mean 'get_task'?") }),
    ]);
    expect(result.manifest).toBeUndefined();
  });

  it("keeps a tool out of the root's own model loop while its subagents inherit it", () => {
    const result = compile({
      "AGENT.md": ROOT(4, "disallowedTools: [get_task]\n"),
      ...LIBRARY,
      "agents/history.md": md("name: history\ndescription: Searches.\n", "Search.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const root = (result.manifest!.harness as { tools: { name: string; agent?: unknown }[] }).tools.filter((item) => item.agent === undefined).map((item) => item.name);
    expect(root.sort()).toEqual(["search_work", "start_task"]);
    expect((subagentTools(result.manifest, "history")!.tools as { name: string }[]).map((item) => item.name)).toContain("get_task");
  });

  it("leaves servers with a credential out unless named, and refuses one named", () => {
    const files = {
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      "mcp.json": JSON.stringify({
        mcpServers: {
          wiki: { type: "streamable-http", url: "https://wiki.example.com/mcp" },
          crm: { type: "streamable-http", url: "https://crm.example.com/mcp", headers: { Authorization: "Bearer ${CRM}" } },
        },
      }),
    };
    const quiet = compile({ ...files, "agents/a.md": md("name: a\ndescription: A.\n", "A.\n") });
    expect(errors(quiet.diagnostics)).toEqual([]);
    expect(Object.keys(subagentTools(quiet.manifest, "a")!.mcpServers as object)).toEqual(["wiki"]);
    const narrowed = compile({ ...files, "agents/b.md": md("name: b\ndescription: B.\ndisallowedTools: [bash]\n", "B.\n") });
    expect(Object.keys(subagentTools(narrowed.manifest, "b")!.mcpServers as object)).toEqual(["wiki"]);
    const none = compile({ ...files, "agents/c.md": md("name: c\ndescription: C.\nmcpServers: {}\n", "C.\n") });
    expect(subagentTools(none.manifest, "c")!.mcpServers).toBeUndefined();
    const named = compile({ ...files, "agents/a.md": md("name: a\ndescription: A.\nmcpServers:\n  crm: {}\n", "A.\n") });
    expect(errors(named.diagnostics)).toEqual([expect.objectContaining({ code: "credential_unsupported" })]);
  });

  it("refuses a subagent folder in agent-folder/4, and a subagent file in an older format", () => {
    const folder = compile({ "AGENT.md": ROOT(4), ...LIBRARY, "agents/old/AGENT.md": md("name: old\ndescription: Old.\n", "Old.\n") });
    expect(errors(folder.diagnostics)).toEqual([expect.objectContaining({ code: "subagent_folder", file: "agents/old/AGENT.md" })]);
    const file = compile({ "AGENT.md": ROOT(3), ...LIBRARY, "agents/new.md": md("name: new\ndescription: New.\n", "New.\n") });
    expect(errors(file.diagnostics)).toEqual([expect.objectContaining({ code: "subagent_file", file: "agents/new.md" })]);
  });

  it("checks a file's name against its file name", () => {
    const result = compile({ "AGENT.md": ROOT(4), ...LIBRARY, "agents/history.md": md("name: past\ndescription: Searches.\n", "Search.\n") });
    expect(errors(result.diagnostics)).toEqual([expect.objectContaining({ code: "name_mismatch", file: "agents/history.md", message: expect.stringContaining("agents/history.md") })]);
  });

  it("reads a schema beside the file", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      "agents/triage.md": md("name: triage\ndescription: Triage.\noutputSchema: ./triage.schema.json\ntools: []\n", "Triage.\n"),
      "agents/triage.schema.json": JSON.stringify({ type: "object", properties: { route: { type: "string" } } }),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(subagentTools(result.manifest, "triage")!.outputSchema).toEqual({ type: "object", properties: { route: { type: "string" } } });
  });
});

describe("agent-folder/4: flows", () => {
  const STAGES = {
    "agents/triage.md": md("name: triage\ndescription: Triage.\n", "Triage.\n"),
    "agents/writer.md": md("name: writer\ndescription: Writes.\nskills: [brief]\ntools: [now]\n", "Write.\n"),
    "agents/research.md": md("name: research\ndescription: Researches, then writes.\nflow: ./research.flow.json\n"),
    "agents/research.flow.json": JSON.stringify({ chain: [{ agent: "writer" }, { tool: "publish" }] }),
    "tools/now.json": tool("now"),
    "tools/publish.json": tool("publish"),
    "skills/brief/SKILL.md": md("name: brief\ndescription: How to write a brief.\n", "Write it well.\n"),
    "mcp.json": JSON.stringify({ mcpServers: { wiki: { type: "streamable-http", url: "https://wiki.example.com/mcp" } } }),
  };

  it("lets a root driven by a flow hold the library its stages draw on", () => {
    const result = compile({
      "AGENT.md": md("name: brief\ndescription: Writes a brief.\nformat: agent-folder/4\n"),
      "runtime.json": JSON.stringify({ kind: "virtual" }),
      "flow.json": JSON.stringify({ chain: [{ agent: "triage" }, { agent: "research" }] }),
      ...STAGES,
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const harness = result.manifest!.harness as { kind: string; agents: Record<string, Record<string, unknown>> };
    expect(harness.kind).toBe("workflow");
    // writer is a stage of research's sub-flow, embedded where that flow names it.
    const writer = (harness.agents.research as { agents: Record<string, Record<string, unknown>> }).agents.writer!;
    expect(Object.keys(writer.skills as object)).toEqual(["brief"]);
    expect((writer.tools as { name: string }[]).map((item) => item.name)).toEqual(["now"]);
    expect(Object.keys(harness.agents.triage!.mcpServers as object)).toEqual(["wiki"]);
  });

  it("offers a subagent driven by a flow to a root driven by a model loop", () => {
    const result = compile({
      "AGENT.md": ROOT(4),
      ...LIBRARY,
      ...STAGES,
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const tools = (result.manifest!.harness as { tools: { name: string; agent?: { kind?: string } }[] }).tools;
    expect(tools.find((item) => item.name === "research")!.agent!.kind).toBe("workflow");
  });
});
