import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@nylorun/core/define";
import { expect, it, vi } from "vitest";
import { loadPlugin, PluginError } from "../src/plugins/load.js";
import { plugin } from "../src/plugins/plugin.js";
import { Agent as FileAgent } from "../src/builder.js";

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function root(): string {
  return mkdtempSync(join(tmpdir(), "nylorun-plugin-"));
}

function write(directory: string, path: string, contents: string): void {
  const file = join(directory, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    $schema: PLUGIN_SCHEMA,
    name,
    ...extra,
  });
}

it("rejects an unsupported schema before discovering components", () => {
  const directory = root();
  write(directory, "plugin.json", JSON.stringify({ $schema: "https://example.com/other", name: "demo" }));
  write(directory, "skills/triage/SKILL.md", "not a skill");
  expect(() => loadPlugin(directory)).toThrow(PluginError);
  try {
    loadPlugin(directory);
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).code).toBe("plugin.schema-unsupported");
    expect((error as PluginError).message).not.toMatch(/SKILL.md/);
  }
});

it("reports unknown manifest fields and ignores a non-object extensions value", () => {
  const directory = root();
  write(
    directory,
    "plugin.json",
    manifest("demo", { extra: true, extensions: ["nope"] })
  );
  write(
    directory,
    "skills/triage/SKILL.md",
    "---\nname: triage\ndescription: Triage an issue.\n---\nRead the issue.\n"
  );
  const loaded = loadPlugin(directory);
  expect(Object.keys(loaded.skills.triage?.files ?? {})).toEqual(["SKILL.md"]);
  expect(loaded.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining(["plugin.unknown-field", "plugin.extensions-ignored"])
  );
});

it("ignores unimplemented extension namespaces without reading their values", () => {
  const directory = root();
  write(
    directory,
    "plugin.json",
    manifest("demo", {
      extensions: { "com.nylorun.agents": { hooks: true }, "com.example.client": 1 },
    })
  );
  const loaded = loadPlugin(directory);
  expect(loaded.diagnostics.map((item) => item.message).join("\n")).toMatch(
    /com\.nylorun\.agents/
  );
  expect(loaded.diagnostics.map((item) => item.message).join("\n")).toMatch(
    /com\.example\.client/
  );
});

it("treats missing component locations as valid and isolates a wrong filesystem kind", () => {
  const missing = root();
  write(missing, "plugin.json", manifest("bare"));
  expect(loadPlugin(missing)).toMatchObject({ skills: {}, mcpServers: {} });

  const wrong = root();
  write(wrong, "plugin.json", manifest("mixed"));
  write(wrong, "skills", "not a directory");
  write(
    wrong,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        github: { type: "streamable-http", url: "https://mcp.example.com/github" },
      },
    })
  );
  const loaded = loadPlugin(wrong);
  expect(loaded.skills).toEqual({});
  expect(loaded.mcpServers.github?.type).toBe("streamable-http");
  expect(loaded.diagnostics.some((item) => item.code === "plugin.skills-invalid")).toBe(true);
});

it("skips an invalid skill and keeps its sibling and MCP servers", async () => {
  const directory = root();
  write(directory, "plugin.json", manifest("docs"));
  write(directory, "skills/broken/SKILL.md", "no frontmatter");
  write(
    directory,
    "skills/triage/SKILL.md",
    "---\nname: triage\ndescription: Triage an issue.\n---\nBody stays stored.\n"
  );
  write(
    directory,
    "skills/triage/references/labels.md",
    "# Labels\n"
  );
  write(
    directory,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        bad: { type: "websocket", url: "wss://mcp.example.com/ws" },
        github: { type: "streamable-http", url: "https://mcp.example.com/github" },
        local: { type: "streamable-http", url: "http://localhost:9/mcp" },
        insecure: { type: "streamable-http", url: "http://example.com/mcp" },
        secret: { type: "streamable-http", url: "https://user:pw@example.com/mcp" },
      },
    })
  );
  const loaded = loadPlugin(directory);
  expect(Object.keys(loaded.skills)).toEqual(["triage"]);
  expect(Object.keys(loaded.skills.triage?.files ?? {})).toEqual(["SKILL.md", "references/labels.md"]);
  const labels = loaded.skills.triage!.files["references/labels.md"]!;
  expect(new TextDecoder().decode(await loaded.skills.triage!.sources[labels]!.read())).toBe("# Labels\n");
  expect(Object.keys(loaded.mcpServers).sort()).toEqual(["github", "local"]);
  expect(loaded.diagnostics.some((item) => item.message.includes("broken"))).toBe(true);
  expect(loaded.diagnostics.some((item) => item.message.includes("bad"))).toBe(true);
  const skipped = loaded.diagnostics
    .filter((item) => item.code === "plugin.mcp-server-skipped")
    .map((item) => item.message);
  expect(skipped).toEqual([
    "Skipped invalid MCP server 'bad': type 'websocket' is not streamable-http or sse",
    "Skipped invalid MCP server 'insecure': plain http is allowed only for localhost, 127.0.0.1 or [::1]; use https for example.com",
    "Skipped invalid MCP server 'secret': url must not carry credentials; use headers",
  ]);
});

it("warns when the agent is built that a plugin's MCP server was skipped, and why", () => {
  const directory = root();
  write(directory, "plugin.json", manifest("tools"));
  write(
    directory,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        local: { type: "streamable-http", url: "http://localhost:3002/mcp" },
        lan: { type: "streamable-http", url: "http://192.168.1.20:3002/mcp" },
      },
    })
  );
  const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    const agent = FileAgent({ id: "bot", name: "Bot" }).plugin(directory).build();
    const servers = agent.manifest.capabilities.find((item) => item.id === "tools")?.mcpServers;
    expect(Object.keys(servers ?? {})).toEqual(["local"]);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(
      "Plugin 'tools': Skipped invalid MCP server 'lan': plain http is allowed only for localhost, 127.0.0.1 or [::1]; use https for 192.168.1.20",
      expect.objectContaining({ type: "NylorunPluginWarning", code: "plugin.mcp-server-skipped" })
    );
  } finally {
    warnings.mockRestore();
  }
});

it("disables MCP when mcp.json does not match the plugin schema and still loads skills", () => {
  const directory = root();
  write(directory, "plugin.json", manifest("docs"));
  write(
    directory,
    "skills/triage/SKILL.md",
    "---\nname: triage\ndescription: Triage an issue.\n---\nRead it.\n"
  );
  write(directory, "mcp.json", "{");
  const invalid = loadPlugin(directory);
  expect(invalid.skills.triage?.name).toBe("triage");
  expect(invalid.mcpServers).toEqual({});

  const mismatch = root();
  write(mismatch, "plugin.json", manifest("docs"));
  write(
    mismatch,
    "mcp.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/9.9.9/mcp.schema.json",
      mcpServers: {
        github: { type: "streamable-http", url: "https://mcp.example.com/github" },
      },
    })
  );
  expect(loadPlugin(mismatch).mcpServers).toEqual({});
});

it("skips a skill whose SKILL.md resolves outside the package", () => {
  const directory = root();
  const outside = root();
  write(directory, "plugin.json", manifest("docs"));
  write(outside, "SKILL.md", "---\nname: triage\ndescription: Outside.\n---\nSecret.\n");
  mkdirSync(join(directory, "skills", "triage"), { recursive: true });
  symlinkSync(join(outside, "SKILL.md"), join(directory, "skills", "triage", "SKILL.md"));
  const loaded = loadPlugin(directory);
  expect(loaded.skills).toEqual({});
  expect(loaded.diagnostics.some((item) => item.code === "plugin.skill-skipped")).toBe(true);
});

it("composes skills and MCP into one agent without putting the skill body in the prompt", async () => {
  const tools = root();
  const docs = root();
  write(tools, "plugin.json", manifest("repository-tools", { description: "Repository MCP" }));
  write(
    tools,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        github: {
          type: "streamable-http",
          url: "https://mcp.example.com/github",
          headers: { "X-Tenant": "public" },
        },
      },
    })
  );
  write(docs, "plugin.json", manifest("documentation"));
  write(
    docs,
    "skills/triage/SKILL.md",
    "---\nname: triage\ndescription: Triage an issue. Use when labeling.\n---\nBody stays stored.\n"
  );
  write(docs, "skills/triage/references/labels.md", "# Labels\n");
  const agent = Agent({
    id: "assistant",
    name: "Order assistant",
    instructions: "Use lookup_order for orders.",
  })
    .use(plugin(tools))
    .use(plugin(docs))
    .build();
  const repository = agent.manifest.capabilities.find((item) => item.id === "repository-tools");
  const documentation = agent.manifest.capabilities.find((item) => item.id === "documentation");
  expect(repository).toMatchObject({
    type: "agent-plugin",
    description: "Repository MCP",
    mcpServers: {
      github: {
        name: "github",
        type: "streamable-http",
        url: "https://mcp.example.com/github",
      },
    },
  });
  expect(documentation?.type).toBe("agent-plugin");
  expect(documentation?.instructions?.join("\n")).toContain("<name>triage</name>");
  expect(documentation?.instructions?.join("\n")).not.toContain("Body stays stored.");
  expect(documentation?.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue. Use when labeling.",
    files: {
      "SKILL.md": expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      "references/labels.md": expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    },
  });
  expect(JSON.stringify(agent.manifest)).not.toContain(realpathSync(tools));
  expect(JSON.stringify(agent.manifest)).not.toContain("Body stays stored.");
  expect(JSON.stringify(agent.manifest)).not.toContain("# Labels");
  // The Runtime serves the skill tools; the declaration carries the files' bytes to upload.
  expect(documentation?.tools?.map((item) => item.name)).toEqual(["load_skill", "read_skill_resource"]);
  const declaration = agent.getBinding().declarations.find((item) => item.id === "documentation");
  expect(Object.keys(declaration?.skillFiles ?? {}).sort()).toEqual(
    Object.values(documentation!.skills!.triage!.files).sort()
  );
  await expect(
    agent.getBinding().tools.find((item) => item.name === "load_skill")!.execute({ name: "triage" }, {} as never)
  ).rejects.toThrow("Skills are served by the Nylorun Runtime");
});

it("advertises one load_skill for every plugin skill", () => {
  const first = root();
  const second = root();
  write(first, "plugin.json", manifest("first-plugin"));
  write(second, "plugin.json", manifest("second-plugin"));
  write(first, "skills/triage/SKILL.md", "---\nname: triage\ndescription: Triage an issue.\n---\nFirst.\n");
  write(second, "skills/summary/SKILL.md", "---\nname: summary\ndescription: Summarize a thread.\n---\nSecond.\n");
  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use(plugin(first))
    .use(plugin(second))
    .build();
  const loads = agent.manifest.capabilities.flatMap((item) => item.tools ?? []).filter((item) => item.name === "load_skill");
  expect(loads).toHaveLength(1);
  expect(loads[0]!.inputSchema).toMatchObject({ properties: { name: { enum: ["summary", "triage"] } } });
});

it("rejects duplicate skill names across plugins", () => {
  const first = root();
  const second = root();
  const skill = "---\nname: triage\ndescription: Triage an issue.\n---\nOne.\n";
  write(first, "plugin.json", manifest("first-plugin"));
  write(second, "plugin.json", manifest("second-plugin"));
  write(first, "skills/triage/SKILL.md", skill);
  write(second, "skills/triage/SKILL.md", skill);
  expect(() =>
    Agent({ id: "assistant", instructions: "Help." })
      .use(plugin(first))
      .use(plugin(second))
      .build()
  ).toThrow(/Duplicate skill 'triage'/);
});

it("refuses a stdio MCP server when the plugin is read", () => {
  const directory = root();
  write(directory, "plugin.json", manifest("local-tools"));
  write(
    directory,
    "mcp.json",
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        github: { type: "streamable-http", url: "https://mcp.example.com/github" },
        local: { type: "stdio", command: "./server.mjs" },
      },
    })
  );
  const refusal =
    "MCP server 'local' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL.";
  expect(() => loadPlugin(directory)).toThrow(refusal);
  expect(() => FileAgent({ id: "bot", name: "Bot" }).plugin(directory)).toThrow(PluginError);
  try {
    loadPlugin(directory);
  } catch (error) {
    expect((error as PluginError).code).toBe("plugin.mcp-stdio");
  }
});
