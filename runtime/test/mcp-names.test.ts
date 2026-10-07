/**
 * R2b C6: MCP tool names every model accepts. MCP allows `.` and 128 characters; OpenAI, Bedrock
 * and Gemini on Vertex take `[A-Za-z0-9_-]` up to 64. The model knows a tool by a normalized
 * name, `mcp.discovered` lists the renamed ones, and the server is still called by its own name.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { listMcpTools, type McpClient } from "../src/mcp/connect.js";
import { McpPool } from "../src/mcp/pool.js";
import { mcpDiscovered, normalizeToolName } from "../src/mcp/snapshot.js";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 8);
const LONG = "a".repeat(100);
const MODEL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A client listing `names`, which keeps the names it is called with. */
function client(names: readonly string[]): McpClient & { called: string[] } {
  const called: string[] = [];
  return {
    called,
    listTools: async () => ({ tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) }),
    callTool: async (params) => {
      called.push(params.name);
      return { result: { content: [{ type: "text", text: "ok" }] } };
    },
  };
}

describe("normalizeToolName", () => {
  it("keeps a name every provider accepts", () => {
    expect(normalizeToolName("github", "get_issue")).toBe("github__get_issue");
  });

  it("replaces a dot and every other character outside [A-Za-z0-9_-]", () => {
    expect(normalizeToolName("files", "read.v2")).toBe("files__read_v2");
    expect(normalizeToolName("files", "read file/now")).toBe("files__read_file_now");
  });

  it("shortens a 100-character name to 55 characters, _ and 8 hex of the raw name's hash", () => {
    const name = normalizeToolName("docs", LONG);
    expect(name).toHaveLength(64);
    expect(name).toBe(`${`docs__${LONG}`.slice(0, 55)}_${hash(`docs/${LONG}`)}`);
    expect(name).toMatch(MODEL_NAME);
  });

  it("suffixes a name that collides, from the raw name", () => {
    expect(normalizeToolName("files", "read.v2", { suffixed: true })).toBe(
      `files__read_v2_${hash("files/read.v2")}`,
    );
  });
});

describe("listing a server's tools", () => {
  it("renames a dotted name, keeps the server's name for the call, and lists the rename", async () => {
    const listed = await listMcpTools(client(["read.v2", "write"]), {
      capabilityId: "mcp",
      serverName: "files",
      taken: new Set(),
    });
    expect(listed.tools.map((tool) => [tool.name, tool.serverToolName])).toEqual([
      ["files__read_v2", "read.v2"],
      ["files__write", "write"],
    ]);
    expect(listed.renamed).toEqual([{ serverToolName: "read.v2", name: "files__read_v2" }]);
    expect(listed.omitted).toEqual([]);
  });

  it("shortens a 100-character name", async () => {
    const listed = await listMcpTools(client([LONG]), { capabilityId: "mcp", serverName: "docs", taken: new Set() });
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]!.name).toMatch(MODEL_NAME);
    expect(listed.tools[0]!.serverToolName).toBe(LONG);
    expect(listed.renamed).toEqual([{ serverToolName: LONG, name: listed.tools[0]!.name }]);
  });

  it("gives a renamed tool the hash when its name collides, whichever the server lists first", async () => {
    for (const names of [
      ["read.v2", "read_v2"],
      ["read_v2", "read.v2"],
    ]) {
      const listed = await listMcpTools(client(names), { capabilityId: "mcp", serverName: "files", taken: new Set() });
      const byServerName = Object.fromEntries(listed.tools.map((tool) => [tool.serverToolName, tool.name]));
      // The server's own `read_v2` keeps its name; the dotted one, renamed onto it, is suffixed.
      expect(byServerName).toEqual({
        read_v2: "files__read_v2",
        "read.v2": `files__read_v2_${hash("files/read.v2")}`,
      });
      expect(listed.tools.map((tool) => tool.serverToolName)).toEqual(names);
      expect(listed.renamed).toEqual([{ serverToolName: "read.v2", name: byServerName["read.v2"] }]);
    }
  });

  it("gives a renamed tool the hash when a declared tool has its name", async () => {
    const listed = await listMcpTools(client(["read.v2"]), {
      capabilityId: "mcp",
      serverName: "files",
      taken: new Set(["files__read_v2"]),
    });
    expect(listed.tools.map((tool) => tool.name)).toEqual([`files__read_v2_${hash("files/read.v2")}`]);
  });
});

describe("the pool", () => {
  const agent = Agent({ id: "bot" })
    .mcp({ files: { type: "streamable-http", url: "https://files.example.invalid/mcp" } })
    .build();

  it("reports renamed tools in mcp.discovered and calls the server by its own name", async () => {
    const remote = client(["read.v2", LONG]);
    const pool = new McpPool({
      authorize: async () => ({ status: "none" }) as never,
      open: async () => ({ client: remote, close: async () => {} }),
    });
    const found = await pool.discover({ sessionId: "s1", manifest: agent.manifest, manifestHash: "h" });
    const names = found.snapshot.mcpTools.map((tool) => tool.name);
    for (const name of names) expect(name).toMatch(MODEL_NAME);
    expect(mcpDiscovered(found.snapshot, found.diagnostics).servers).toEqual([
      expect.objectContaining({
        serverName: "files",
        outcome: "connected",
        tools: 2,
        renamed: [
          { serverToolName: "read.v2", name: "files__read_v2" },
          { serverToolName: LONG, name: names[1] },
        ],
      }),
    ]);
    const outcome = await pool.call({
      sessionId: "s1",
      capabilityId: found.snapshot.mcpTools[0]!.capabilityId,
      serverName: "files",
      serverToolName: found.snapshot.mcpTools[0]!.serverToolName,
      args: {},
      manifest: agent.manifest,
    });
    expect(outcome).toEqual({ kind: "completed", output: "ok" });
    expect(remote.called).toEqual(["read.v2"]);
    await pool.close();
  });
});
