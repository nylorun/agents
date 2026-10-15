/**
 * The session's MCP tools as our engine names them (R2b C6, protocol 15): MCP allows `.` and 128
 * characters; OpenAI, Bedrock and Gemini on Vertex take `[A-Za-z0-9_-]` up to 64. Our engine
 * names each tool from the turn's facts, leaves out what the turn disables or it cannot use, makes
 * each call an effect of the tool's identity, and keeps its deferral in its state.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type AgentManifest } from "@nylorun/core/define";
import type { McpFacts, ModelDescriptor } from "@nylorun/core/harness-api";
import { createDurableCheckpoint, runDurable, type DurableHost } from "../src/run/index.js";
import {
  DEFAULT_MCP_TOOL_CONFIG,
  MODEL_TOOL_NAME_MAX,
  mcpToolName,
  mcpToolNames,
  mcpToolSet,
} from "../src/tools/mcp.js";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 8);
const LONG = "a".repeat(100);
const MODEL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const config = DEFAULT_MCP_TOOL_CONFIG;

describe("mcpToolName", () => {
  it("keeps a name every provider accepts", () => {
    expect(mcpToolName("github", "get_issue")).toBe("github__get_issue");
  });

  it("replaces a dot and every other character outside [A-Za-z0-9_-]", () => {
    expect(mcpToolName("files", "read.v2")).toBe("files__read_v2");
    expect(mcpToolName("files", "read file/now")).toBe("files__read_file_now");
  });

  it("shortens a 100-character name to 55 characters, _ and 8 hex of the raw name's hash", () => {
    const name = mcpToolName("docs", LONG);
    expect(name).toHaveLength(MODEL_TOOL_NAME_MAX);
    expect(name).toBe(`${`docs__${LONG}`.slice(0, 55)}_${hash(`docs/${LONG}`)}`);
    expect(name).toMatch(MODEL_NAME);
  });

  it("suffixes a name that collides, from the raw name", () => {
    expect(mcpToolName("files", "read.v2", { suffixed: true })).toBe(
      `files__read_v2_${hash("files/read.v2")}`,
    );
  });
});

describe("naming a server's tools", () => {
  it("renames a dotted name and lists the rename", () => {
    const named = mcpToolNames("files", ["read.v2", "write"], new Set());
    expect([...named.names]).toEqual([
      ["write", "files__write"],
      ["read.v2", "files__read_v2"],
    ]);
    expect(named.renamed).toEqual([{ serverToolName: "read.v2", name: "files__read_v2" }]);
    expect(named.omitted).toEqual([]);
  });

  it("gives a renamed tool the hash when its name collides, whichever the server lists first", () => {
    for (const tools of [
      ["read.v2", "read_v2"],
      ["read_v2", "read.v2"],
    ]) {
      const { names, renamed } = mcpToolNames("files", tools, new Set());
      // The server's own `read_v2` keeps its name; the dotted one, renamed onto it, is suffixed.
      expect(Object.fromEntries(names)).toEqual({
        read_v2: "files__read_v2",
        "read.v2": `files__read_v2_${hash("files/read.v2")}`,
      });
      expect(renamed).toEqual([{ serverToolName: "read.v2", name: names.get("read.v2") }]);
    }
  });

  it("suffixes a renamed tool whose name another tool took, and leaves out one whose own name is taken", () => {
    const taken = new Set(["files__read_v2", "files__write"]);
    const { names, omitted } = mcpToolNames("files", ["read.v2", "write"], taken);
    expect(names.get("read.v2")).toBe(`files__read_v2_${hash("files/read.v2")}`);
    expect(names.has("write")).toBe(false);
    expect(omitted).toEqual(["files__write"]);
  });
});

describe("the MCP tool set", () => {
  const manifest: AgentManifest = Agent({ id: "bot" })
    .tools({ name: "notes", inputSchema: z.object({}), execute: async () => "unused" })
    .mcp({ files: { type: "streamable-http", url: "https://files.example.invalid/mcp" } })
    .build().manifest;
  const tool = (
    name: string,
    enabled = true,
    inputSchema: Record<string, unknown> = { type: "object" },
  ) => ({
    name,
    inputSchema,
    enabled,
  });
  const facts: McpFacts = {
    servers: [
      {
        name: "files",
        tools: [
          tool("read.v2"),
          tool(LONG),
          tool("drop", false),
          // A schema our engine cannot check calls against.
          tool("broken", true, { type: "object", properties: { x: { $ref: "#/nowhere" } } }),
          tool("notes"),
          tool("bash"),
        ],
      },
    ],
  };

  it("names each enabled tool it can use, within 64 characters, and makes its calls the tool's identity", () => {
    // A name our engine's other tools take (none has `__` today, as no declared tool may).
    const set = mcpToolSet(facts, manifest, {
      config,
      taken: () => ["files__notes", "files__bash"],
    });
    for (const item of set.tools) expect(item.name).toMatch(MODEL_NAME);
    expect(set.tools.map((item) => [item.name, item.target])).toEqual([
      ["files__read_v2", { kind: "mcp", server: "files", tool: "read.v2" }],
      [mcpToolName("files", LONG), { kind: "mcp", server: "files", tool: LONG }],
      // `notes` and `bash` would take names our engine's other tools hold: left out.
    ]);
  });

  it("names an agent used as a tool's tools for it, apart from the root's", () => {
    const child = Agent({ id: "helper", description: "Helps." }).mcp({
      files: { type: "streamable-http", url: "https://files.example.invalid/mcp" },
    });
    const root = Agent({ id: "bot", tools: [child] })
      .mcp({ files: { type: "streamable-http", url: "https://files.example.invalid/mcp" } })
      .build().manifest;
    const set = mcpToolSet(
      {
        servers: [
          { name: "files", tools: [tool("read")] },
          { agentId: "helper", name: "files", tools: [tool("read")] },
        ],
      },
      root,
      { config },
    );
    // Each agent names its own server's tools: the same name, for the agent that declares it.
    expect(set.tools).toEqual([
      {
        name: "files__read",
        inputSchema: { type: "object" },
        target: { kind: "mcp", server: "files", tool: "read" },
      },
      {
        agentId: "helper",
        name: "files__read",
        inputSchema: { type: "object" },
        target: { kind: "mcp", server: "files", tool: "read" },
      },
    ]);
  });
});

describe("the layout our engine pins (R2b C10)", () => {
  const manifest = Agent({ id: "a" })
    .mcp({ s: { type: "streamable-http", url: "https://s.example.invalid/mcp" } })
    .build().manifest;
  const facts = (count: number): McpFacts => ({
    servers: [
      {
        name: "s",
        tools: Array.from({ length: count }, (_, i) => ({
          name: `t${i}`,
          description: "d".repeat(1_000),
          inputSchema: { type: "object" },
          enabled: true,
        })),
      },
    ],
  });
  const model = (contextWindow: number): ModelDescriptor => ({
    provider: "p",
    id: "m",
    inputs: ["text"],
    contextWindow,
    maxOutputTokens: 1024,
  });
  const answering: DurableHost = {
    async resolveEffect() {
      return {
        status: "completed",
        outcome: { value: { output: [{ type: "text", text: "ok" }] } },
      };
    },
  };

  it("keeps the deferral in our state, and follows it while the facts stay the same", async () => {
    const first = mcpToolSet(facts(10), manifest, { config, model: model(1_024) });
    expect(first.tools.filter((item) => item.deferred)).toHaveLength(10);
    const result = await runDurable({
      manifest,
      checkpoint: createDurableCheckpoint({ manifest, sessionId: "s", turnId: "t1", input: "go" }),
      host: answering,
      mcp: first,
    });
    const layout = result.checkpoint.state?.mcpLayout;
    expect(layout).toEqual({
      factsHash: first.layout.factsHash,
      deferred: [...first.layout.deferred],
    });
    // The Tenant's model changed to one with a large window: the session lists the same tools.
    const next = mcpToolSet(facts(10), manifest, { config, model: model(1_000_000), layout });
    expect(next.tools.map((item) => item.name)).toEqual(first.tools.map((item) => item.name));
    // Other facts: decided again.
    const changed = mcpToolSet(facts(3), manifest, { config, model: model(1_000_000), layout });
    expect(changed.tools.filter((item) => item.deferred)).toEqual([]);
    expect(changed.layout.factsHash).not.toBe(layout!.factsHash);
  });
});
