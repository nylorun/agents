import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";
import { Agent, DELEGATE_INPUT_SCHEMA, http } from "../src/define.js";
import { harnessSectionOf, sectionGaps } from "../src/definition/sections.js";

/** Flows, subagents and vendored plugins in an agent folder (track T7, design §3.3, §3.8). */

const encoder = new TextEncoder();

function folder(files: Record<string, string | Uint8Array | undefined>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    const data = typeof content === "string" ? encoder.encode(content) : content;
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  const text = new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!]));
  return { entries, files: text, hash: (path: string) => `sha256:${entries.find((entry) => entry.path === path)!.sha256}` };
}

function compile(files: Record<string, string | Uint8Array | undefined>, name?: string) {
  const { entries, files: text } = folder(files);
  return compileAgentFolder({ entries, files: text, ...(name === undefined ? {} : { name }) });
}

const errors = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "error");
const agentMd = (name: string, description: string, body = "", extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;

/** A small flow: draft, checked by an editor in a loop, then published by an HTTP stage. */
const FLOW = {
  "AGENT.md": agentMd("brief", "Writes a brief.", "", "inputSchema: ./input.schema.json\n"),
  "input.schema.json": `{ "type": "object", "properties": { "topic": { "type": "string" } } }`,
  "flow.json": `{
  "chain": [
    { "id": "draft", "loop": { "run": { "agent": "writer" }, "verify": { "agent": "editor" }, "max": 3 } },
    { "id": "publish", "tool": "publish" }
  ]
}
`,
  "tools/publish.json": `{ "description": "Publish it.", "inputSchema": { "type": "object" }, "http": { "url": "https://cms.example.com/publish", "credential": "CMS_TOKEN" } }`,
  "agents/writer/AGENT.md": agentMd("writer", "Writes the draft.", "Write it.\n"),
  "agents/editor/AGENT.md": agentMd("editor", "Checks the draft.", "Check it.\n"),
};

describe("agent folders: subagents", () => {
  it("offers agents/<id>/ as a tool, exactly as the TypeScript builder offers an agent used as a tool", () => {
    const result = compile({
      "AGENT.md": agentMd("lead", "Leads the work.", "Lead.\n"),
      "agents/research/AGENT.md": agentMd("research", "Researches one question.", "Research.\n", "outputSchema: ./output.schema.json\n"),
      "agents/research/output.schema.json": JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      }),
      "agents/research/tools/now.json": `{ "description": "The time.", "inputSchema": { "type": "object" }, "http": { "url": "https://tools.example.com/now" } }`,
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const research = Agent({ id: "research", description: "Researches one question." })
      .instructions("Research.")
      .tools(http({ name: "now", description: "The time.", input: { type: "object" }, url: "https://tools.example.com/now" }))
      .output(z.object({ answer: z.string() }));
    const lead = Agent({ id: "lead", description: "Leads the work." }).instructions("Lead.").subagents(research).build();
    expect(result.manifest!.harness).toEqual(harnessSectionOf(lead.manifest));
    expect(result.manifest!.harness).toMatchObject({ tools: [{ name: "research", inputSchema: DELEGATE_INPUT_SCHEMA, agent: { manifestSchemaVersion: 7, id: "research" } }] });
  });

  it("offers a subagent that is a flow as a tool, with the flow's own agents/", () => {
    const result = compile({
      "AGENT.md": agentMd("lead", "Leads the work.", "Lead.\n"),
      "agents/research/AGENT.md": agentMd("research", "Researches a question and reports back."),
      "agents/research/flow.json": `{ "chain": [{ "agent": "searcher" }, { "agent": "summarizer" }] }`,
      "agents/research/agents/searcher/AGENT.md": agentMd("searcher", "The searcher.", "Be searcher.\n"),
      "agents/research/agents/summarizer/AGENT.md": agentMd("summarizer", "The summarizer.", "Be summarizer.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    const agent = (id: string) => Agent({ id, description: `The ${id}.` }).instructions(`Be ${id}.`);
    const research = Agent({ id: "research", description: "Researches a question and reports back." }).pipe(agent("searcher")).pipe(agent("summarizer"));
    const lead = Agent({ id: "lead", description: "Leads the work." }).instructions("Lead.").subagents(research).build();
    expect(result.manifest!.harness).toEqual(harnessSectionOf(lead.manifest));
  });

  it("derives a subagent's slot in the root's runtime section, named by its file, line and column", () => {
    const result = compile({
      "AGENT.md": agentMd("lead", "Leads.", "Lead.\n"),
      "agents/shop/AGENT.md": agentMd("shop", "Looks up orders.", "Look.\n"),
      "agents/shop/tools/order.json": `{\n  "inputSchema": { "type": "object" },\n  "http": { "url": "https://shop.example.com/orders", "credential": "SHOP" }\n}\n`,
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest!.runtime).toEqual({ kind: "none", secrets: { SHOP: { type: "bearer", url: "https://shop.example.com/orders", required: true } } });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "slot_derived", file: "agents/shop/tools/order.json", line: 3, column: 69, pointer: "/runtime/secrets/SHOP" }),
    );
    expect(sectionGaps(result.manifest!)).toEqual([]);
  });

  it("keeps file, line and column for a typo inside a subagent", () => {
    const result = compile({
      "AGENT.md": agentMd("lead", "Leads.", "Lead.\n"),
      "agents/shop/AGENT.md": agentMd("shop", "Looks up orders.", "Look.\n", "outputSchem: ./out.schema.json\n"),
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "unknown_key", file: "agents/shop/AGENT.md", line: 4, column: 1, message: "Unknown key 'outputSchem'. Did you mean 'outputSchema'?" }),
    ]);
  });

  it("refuses what only the root has, and subagents two levels deep", () => {
    const result = compile({
      "AGENT.md": agentMd("lead", "Leads.", "Lead.\n"),
      "agents/shop/AGENT.md": agentMd("shop", "Shops.", "Shop.\n", "format: 1\nmemory: { access: read_only }\n"),
      "agents/shop/runtime.json": `{ "kind": "virtual" }`,
      "agents/shop/triggers/nightly.md": `---\nschedule: "0 2 * * *"\nsession: new\n---\nGo.\n`,
      "agents/shop/files/a.txt": "a",
      "agents/shop/agents/deeper/AGENT.md": agentMd("deeper", "Deeper.", "Deeper.\n"),
    });
    expect(errors(result.diagnostics).map((item) => [item.code, item.file, item.line ?? null])).toEqual([
      ["nested_refused", "agents/shop/AGENT.md", 4],
      ["nested_refused", "agents/shop/AGENT.md", 5],
      ["subagent_depth", "agents/shop/agents/deeper/AGENT.md", null],
      ["nested_refused", "agents/shop/files/a.txt", null],
      ["nested_refused", "agents/shop/runtime.json", null],
      ["nested_refused", "agents/shop/triggers/nightly.md", null],
    ]);
  });

  it("refuses a credential an embedded agent cannot carry, an id that is no tool name, and a name used twice", () => {
    const result = compile({
      "AGENT.md": agentMd("lead", "Leads.", "Lead.\n"),
      "tools/shop.json": `{ "inputSchema": { "type": "object" }, "http": { "url": "https://shop.example.com/" } }`,
      "agents/shop/AGENT.md": agentMd("shop", "Shops.", "Shop.\n"),
      "agents/gh/AGENT.md": agentMd("gh", "GitHub.", "Go.\n"),
      "agents/gh/mcp.json": `{\n  "mcpServers": {\n    "github": { "type": "sse", "url": "https://mcp.example.com/", "headers": { "Authorization": "Bearer \${GH}" } }\n  }\n}\n`,
      "agents/my.agent/AGENT.md": agentMd("my.agent", "Dotted.", "Go.\n"),
    });
    expect(errors(result.diagnostics).map((item) => [item.code, item.file, item.line ?? null])).toEqual([
      ["credential_unsupported", "agents/gh/mcp.json", 3],
      ["agent_name", "agents/my.agent/AGENT.md", null],
      ["tool_twice", "agents/shop/AGENT.md", null],
    ]);
  });

  it("takes inputSchema in a flow's AGENT.md only", () => {
    const result = compile({ "AGENT.md": agentMd("a", "b", "Go.\n", "inputSchema: ./in.schema.json\n"), "in.schema.json": "{}" });
    expect(errors(result.diagnostics)).toEqual([expect.objectContaining({ code: "input_schema_refused", file: "AGENT.md", line: 4, column: 1 })]);
  });
});

describe("agent folders: flows", () => {
  it("compiles flow.json to the workflow harness, with the agents and tools its nodes name", () => {
    const result = compile(FLOW);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest).toEqual({
      manifestSchemaVersion: 8,
      name: "brief",
      description: "Writes a brief.",
      harness: {
        kind: "workflow",
        inputSchema: { type: "object", properties: { topic: { type: "string" } } },
        root: {
          chain: [
            { id: "draft", loop: { run: { agent: "writer" }, verify: { agent: "editor" }, max: 3 } },
            {
              id: "publish",
              tool: {
                name: "publish",
                description: "Publish it.",
                inputSchema: { type: "object" },
                http: { url: "https://cms.example.com/publish", credential: "CMS_TOKEN" },
              },
            },
          ],
        },
        agents: {
          writer: { manifestSchemaVersion: 7, id: "writer", description: "Writes the draft.", instructions: ["Write it."] },
          editor: { manifestSchemaVersion: 7, id: "editor", description: "Checks the draft.", instructions: ["Check it."] },
        },
      },
      runtime: { kind: "none", secrets: { CMS_TOKEN: { type: "bearer", url: "https://cms.example.com/publish", required: true } } },
    });
    expect(sectionGaps(result.manifest!)).toEqual([]);
  });

  it("takes $schema in flow.json, as in every JSON file, and leaves it out of the manifest", () => {
    const flow = (schema: string) => compile({ ...FLOW, "flow.json": FLOW["flow.json"].replace("{", `{ "$schema": "${schema}",`) });
    const named = flow("https://docs.nylorun.com/schemas/agent-folder/v1/flow.json");
    expect(named.diagnostics.filter((item) => item.severity === "error" || item.severity === "warning")).toEqual([]);
    expect(named.manifest).toEqual(compile(FLOW).manifest);
    // Another kind's schema is a warning, never a refusal.
    const other = flow("https://docs.nylorun.com/schemas/agent-folder/v1/tool.json");
    expect(errors(other.diagnostics)).toEqual([]);
    expect(other.diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", code: "schema_url", file: "flow.json" }));
  });

  it("compiles the same flow as the TypeScript builder", () => {
    const result = compile({ ...FLOW, "AGENT.md": agentMd("brief", "Writes a brief.") });
    const agent = (id: string, description: string, text: string) => Agent({ id, description }).instructions(text);
    const built = Agent({ id: "brief", description: "Writes a brief." })
      .loop(agent("writer", "Writes the draft.", "Write it."), { verify: agent("editor", "Checks the draft.", "Check it."), max: 3, id: "draft" })
      .pipe(
        http({ name: "publish", description: "Publish it.", input: { type: "object" }, url: "https://cms.example.com/publish", credential: "CMS_TOKEN" }),
      )
      .build();
    const harness = harnessSectionOf(built.manifest) as { root: { chain: Record<string, unknown>[] } };
    // The builder names a stage by its tool; the folder's node names it "publish" with id.
    expect(result.manifest!.harness).toEqual({ ...harness, root: { chain: [harness.root.chain[0], { ...harness.root.chain[1], id: "publish" }] } });
  });

  it("verifies with an HTTP tool: { tool } in the folder, { http } in the manifest", () => {
    const result = compile({
      ...FLOW,
      "flow.json": `{ "loop": { "run": { "agent": "writer" }, "verify": { "tool": "check" }, "max": 2 } }`,
      "tools/publish.json": undefined,
      "tools/check.json": `{ "inputSchema": { "type": "object" }, "http": { "url": "https://cms.example.com/check" } }`,
      "agents/editor/AGENT.md": undefined,
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect((result.manifest!.harness as { root: unknown }).root).toEqual({
      loop: { run: { agent: "writer" }, verify: { http: { url: "https://cms.example.com/check" } }, max: 2 },
    });
  });

  it("compiles repo-brief as a folder: 23 files, a sub-flow over one flat agents/", () => {
    const root = fileURLToPath(new URL("../../examples/agents/repo-brief-folder/", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    const files = Object.fromEntries(walk(root).map((file) => [relative(root, file).split("\\").join("/"), new Uint8Array(readFileSync(file))]));
    expect(Object.keys(files)).toHaveLength(23);
    const result = compile(files, "repo-brief");
    expect(result.diagnostics).toEqual([]);
    const harness = result.manifest!.harness as { kind: string; agents: Record<string, Record<string, unknown>> };
    expect(harness.kind).toBe("workflow");
    expect(Object.keys(harness.agents)).toEqual(["triage", "research", "decline"]);
    expect(harness.agents.research).toMatchObject({
      kind: "workflow",
      workflowSchemaVersion: 3,
      id: "research",
      root: { chain: [{ id: "ask" }, { id: "review" }, { id: "draft" }, { tool: { name: "publish_brief", inputSchema: { required: ["title", "markdown"] } } }] },
    });
    expect(Object.keys(harness.agents.research!.agents as object)).toEqual(["researcher", "overview", "risks", "writer", "editor"]);
    // /schemas/brief.json is the flow root's: the writer's output and the publish stage's input.
    const research = harness.agents.research as { agents: Record<string, { outputSchema?: unknown }>; root: { chain: { tool?: { inputSchema: unknown } }[] } };
    expect(research.agents.writer!.outputSchema).toEqual(research.root.chain[3]!.tool!.inputSchema);
  });

  it("names a sub-flow's mistakes by their file under the flow root, with line, column and a fix", () => {
    const result = compile({
      "AGENT.md": agentMd("top", "Top."),
      "flow.json": `{ "chain": [{ "agent": "research" }] }`,
      "agents/research/AGENT.md": agentMd("research", "Research."),
      "agents/research/flow.json": `{\n  "chain": [\n    { "agent": "writter" },\n    { "tool": "publsh" }\n  ]\n}\n`,
      "agents/research/tools/publish.json": `{ "inputSchema": { "type": "object" }, "http": { "url": "https://x.example.com/p" } }`,
      "agents/writer/AGENT.md": agentMd("writer", "Writes.", "Write.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "agent_unknown", file: "agents/research/flow.json", line: 3, column: 16, message: "No agent writter is in the flow root's agents/. Did you mean 'writer'?" }),
      expect.objectContaining({ code: "tool_unknown", file: "agents/research/flow.json", line: 4, column: 15, message: expect.stringContaining("Did you mean 'publish'?") }),
      expect.objectContaining({ code: "tool_unused", file: "agents/research/tools/publish.json" }),
    ]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", code: "agent_unused", file: "agents/writer/AGENT.md" }));
  });

  it("warns on an agent no flow.json names, and leaves it out", () => {
    const result = compile({ ...FLOW, "agents/reviewer/AGENT.md": agentMd("reviewer", "Reviews.", "Review.\n") });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "agent_unused", file: "agents/reviewer/AGENT.md", message: expect.stringContaining("No flow.json under the flow root names reviewer") }),
    );
    expect(Object.keys((result.manifest!.harness as { agents: object }).agents)).toEqual(["writer", "editor"]);
  });

  it("refuses what a flow has none of", () => {
    const result = compile({
      ...FLOW,
      "AGENT.md": agentMd("brief", "Writes a brief.", "\nYou write briefs.\n", "mcpServers: {}\n"),
      "instructions/01.md": "More.\n",
      "mcp.json": `{ "mcpServers": {} }`,
      "skills/style/SKILL.md": agentMd("style", "Style."),
      "plugins/docs/plugin.json": "{}",
    });
    expect(errors(result.diagnostics).map((item) => [item.code, item.file, item.line ?? null])).toEqual([
      ["flow_refused", "AGENT.md", 4],
      ["flow_body", "AGENT.md", 7],
      ["flow_refused", "instructions/01.md", null],
      ["flow_refused", "mcp.json", null],
      ["flow_refused", "plugins/docs/", null],
      ["flow_refused", "skills/style/", null],
    ]);
  });

  it("refuses agents/ in a sub-flow, and a sub-flow that runs itself", () => {
    const result = compile({
      "AGENT.md": agentMd("top", "Top."),
      "flow.json": `{ "agent": "loop" }`,
      "agents/loop/AGENT.md": agentMd("loop", "Loops."),
      "agents/loop/flow.json": `{ "chain": [{ "agent": "loop" }] }`,
      "agents/loop/agents/inner/AGENT.md": agentMd("inner", "Inner.", "Go.\n"),
    });
    expect(errors(result.diagnostics).map((item) => [item.code, item.file])).toEqual([
      ["flow_namespace", "agents/loop/agents/inner/AGENT.md"],
      ["flow_cycle", "agents/loop/flow.json"],
    ]);
  });

  it("checks each node with v3's names, and suggests the right one", () => {
    const run = (tree: string) => errors(compile({ ...FLOW, "flow.json": tree }).diagnostics);
    expect(run(`{ "chian": [] }`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unknown_key", file: "flow.json", line: 1, column: 3, message: "Unknown key 'chian'. Did you mean 'chain'?" })]),
    );
    expect(run(`{ "agent": "writer", "loop": {} }`)[0]).toMatchObject({ code: "flow_invalid", message: expect.stringContaining("this one has agent and loop") });
    expect(run(`{ "loop": { "run": { "agent": "writer" }, "verify": { "agent": "editor" }, "max": 0 } }`)[0]).toMatchObject({
      code: "flow_invalid",
      line: 1,
      column: 83,
      message: expect.stringContaining("max"),
    });
    expect(run(`{ "tool": { "name": "publish" } }`)[0]).toMatchObject({ code: "flow_invalid", message: expect.stringContaining("tools/<name>.json") });
    expect(run(`{ "loop": { "run": { "agent": "writer" }, "verify": { "http": { "url": "https://x.example.com" } }, "max": 1 } }`)[0]).toMatchObject({
      code: "flow_invalid",
      message: expect.stringContaining('"verify": { "tool": "<name>" }'),
    });
  });
});

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN = {
  "plugins/docs/plugin.json": JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "docs", version: "1.2.0" }),
  "plugins/docs/mcp.json": JSON.stringify({
    $schema: MCP_SCHEMA,
    mcpServers: { github: { type: "streamable-http", url: "https://mcp.example.com/github", headers: { "X-A": "b" } } },
  }),
  "plugins/docs/skills/triage/SKILL.md": "---\nname: triage\ndescription: Triage an issue.\n---\nBody.\n",
  "plugins/docs/skills/triage/references/labels.md": "# Labels\n",
};

describe("agent folders: vendored Agent Plugins", () => {
  it("folds a plugin's skills and servers as .plugin() does, labelled, and lists the plugin", () => {
    // The plugin's skill needs a sandbox, as any skill does.
    const files = { "AGENT.md": agentMd("parent", "P.", "Parent.\n"), "runtime.json": `{ "kind": "virtual" }`, ...PLUGIN };
    const { hash } = folder(files);
    const result = compile(files);
    expect(errors(result.diagnostics)).toEqual([]);
    const label = { name: "docs", version: "1.2.0" };
    // What the SDK's `.plugin()` folds from the same files (sdks/agents/test/folder-plugins.test.ts).
    expect(result.manifest!.harness).toEqual({
      instructions: ["Parent."],
      mcpServers: { github: { name: "github", type: "streamable-http", url: "https://mcp.example.com/github", headers: { "X-A": "b" }, plugin: label } },
      skills: {
        triage: {
          name: "triage",
          description: "Triage an issue.",
          files: { "SKILL.md": hash("plugins/docs/skills/triage/SKILL.md"), "references/labels.md": hash("plugins/docs/skills/triage/references/labels.md") },
          plugin: label,
        },
      },
      plugins: [label],
    });
  });

  it("notes what Nylorun does not run, and reads the plugin's files by the folder's rules", () => {
    const files = {
      "AGENT.md": agentMd("parent", "P.", "Parent.\n", "mcpServers:\n  github: { deferred: true, credential: GH_TOKEN }\n"),
      "runtime.json": `{ "kind": "virtual" }`,
      ...PLUGIN,
      "plugins/docs/plugin.json": JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "docs", homepage: "https://docs.example.com", tags: ["x"] }),
      "plugins/docs/hooks/hooks.json": "{}",
      "plugins/docs/commands/triage.md": "x",
      "plugins/docs/README.md": "x",
    };
    const result = compile(files);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest!.harness).toMatchObject({ mcpServers: { github: { deferred: true, credential: "GH_TOKEN", plugin: { name: "docs" } } }, plugins: [{ name: "docs" }] });
    expect(result.manifest!.runtime).toEqual({ kind: "virtual", secrets: { GH_TOKEN: { type: "bearer", url: "https://mcp.example.com/github", required: true } } });
    const others = result.diagnostics.filter((item) => item.severity !== "error" && item.code.startsWith("plugin_")).map((item) => [item.severity, item.code, item.file]);
    expect(others).toEqual([
      ["warning", "plugin_unknown_key", "plugins/docs/plugin.json"],
      ["note", "plugin_part_ignored", "plugins/docs/README.md"],
      ["note", "plugin_part_ignored", "plugins/docs/commands/"],
      ["note", "plugin_part_ignored", "plugins/docs/hooks/"],
    ]);
  });

  it("refuses a plugin without its schemas, a server named twice, and a credential for the agent's own server", () => {
    const result = compile({
      "AGENT.md": agentMd("parent", "P.", "Parent.\n", "mcpServers:\n  own: { credential: OWN }\n"),
      "mcp.json": JSON.stringify({ mcpServers: { github: { type: "sse", url: "https://a.example.com/" }, own: { type: "sse", url: "https://b.example.com/" } } }),
      ...PLUGIN,
      "plugins/docs/mcp.json": `{\n  "mcpServers": {\n    "github": { "type": "sse", "url": "https://c.example.com/" }\n  }\n}\n`,
      "plugins/bare/plugin.json": JSON.stringify({ name: "Bare" }),
    });
    expect(errors(result.diagnostics).map((item) => [item.code, item.file, item.line ?? null])).toEqual([
      ["unknown_key", "AGENT.md", 5],
      ["plugin_invalid", "plugins/bare/plugin.json", 1],
      ["plugin_invalid", "plugins/bare/plugin.json", 1],
      ["plugin_invalid", "plugins/docs/mcp.json", 1],
      ["plugin_duplicate", "plugins/docs/mcp.json", 3],
    ]);
  });

  it("reads the files of nested folders and plugins, and only those the compiler needs", () => {
    const { entries } = folder({
      "AGENT.md": "x",
      "flow.json": "{}",
      "agents/a/AGENT.md": "x",
      "agents/a/flow.json": "{}",
      "agents/a/tools/t.json": "{}",
      "agents/a/files/big.bin": "x",
      "agents/a/skills/s/SKILL.md": "x",
      "agents/a/skills/s/run.sh": "x",
      ...PLUGIN,
      "plugins/docs/hooks/hooks.json": "{}",
    });
    expect(folderTextPaths(entries)).toEqual([
      "AGENT.md",
      "agents/a/AGENT.md",
      "agents/a/flow.json",
      "agents/a/skills/s/SKILL.md",
      "agents/a/tools/t.json",
      "flow.json",
      "plugins/docs/mcp.json",
      "plugins/docs/plugin.json",
      "plugins/docs/skills/triage/SKILL.md",
    ]);
  });
});
