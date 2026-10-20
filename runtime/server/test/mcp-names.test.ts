/**
 * Protocol 15: the Runtime lists a server's tools as the server names them. MCP allows `.` and 128
 * characters; the harness names each tool for the model (Nylorun's engine: `mcpToolName` in
 * `@nylorun/harness`), and every call names the tool by its server and its own name.
 */
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import { describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { listMcpTools, UNPREFIXED_TOOLS_META_KEY, type McpClient } from "../src/mcp/connect.js";
import { McpPool } from "../src/mcp/pool.js";
import { mcpDiscovered } from "../src/mcp/snapshot.js";

const LONG = "a".repeat(100);

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

describe("listing a server's tools", () => {
  it("keeps each name as the server gives it, dotted and long ones too", async () => {
    const listed = await listMcpTools(client(["read.v2", "write", LONG]), { serverName: "files" });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["read.v2", "write", LONG]);
    expect(listed.omitted).toEqual([]);
  });

  it("lists the tools its settings disable, and counts them", async () => {
    const server = {
      name: "files",
      type: "streamable-http",
      url: "https://files.example.invalid/mcp",
      tools: { write: { enabled: false }, gone: { enabled: false } },
    } as const;
    const listed = await listMcpTools(client(["read", "write"]), { serverName: "files", server });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(listed.disabled).toBe(1);
    expect(listed.unknownTools).toEqual(["gone"]);
  });

  it("leaves out a tool whose input schema is not an object", async () => {
    const odd: McpClient = {
      listTools: async () => ({ tools: [{ name: "a", inputSchema: { type: "object" } }, { name: "b" }] }),
      callTool: async () => ({ result: {} }),
    };
    const listed = await listMcpTools(odd, { serverName: "files" });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["a"]);
    expect(listed.omitted).toEqual(["b"]);
  });
});

describe("a gateway's tool prefix (#494)", () => {
  it("reports, across pages, the tools a gateway listed without the prefix", async () => {
    const pages = [
      { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "2" },
      {
        tools: [{ name: "plain", inputSchema: { type: "object" } }],
        _meta: { [UNPREFIXED_TOOLS_META_KEY]: ["plain"] },
      },
    ];
    const paged: McpClient = {
      listTools: async (params) => pages[params?.cursor ? 1 : 0]!,
      callTool: async () => ({ result: {} }),
    };
    const listed = await listMcpTools(paged, { serverName: "x" });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo", "plain"]);
    expect(listed.unprefixed).toEqual(["plain"]);
    expect((await listMcpTools(client(["echo"]), { serverName: "x" })).unprefixed).toEqual([]);
  });
});

describe("the pool", () => {
  const agent = Agent({ id: "bot" })
    .mcp({ files: { type: "streamable-http", url: "https://files.example.invalid/mcp" } })
    .build();

  it("pins the raw names, says nothing of renaming in mcp.discovered, and calls the server by its own name", async () => {
    const remote = client(["read.v2", LONG]);
    const pool = new McpPool({
      openRemote: async () => ({ client: remote, close: async () => {} }),
    });
    const found = await pool.discover({
      sessionId: "s1",
      manifest: agent.manifest,
      manifestHash: "h",
      maxInstructionBytes: RUNTIME_LIMIT_DEFAULTS.recordEntryBytes,
    });
    expect(found.snapshot).toMatchObject({
      snapshotSchemaVersion: 2,
      servers: [{ name: "files", tools: [{ name: "read.v2" }, { name: LONG }] }],
    });
    const [server] = mcpDiscovered(found.snapshot, found.diagnostics, agent.manifest).servers;
    expect(server).toMatchObject({ serverName: "files", outcome: "connected", tools: 2 });
    expect(server).not.toHaveProperty("renamed");
    expect(server).not.toHaveProperty("deferred");
    const outcome = await pool.call({
      maxResultBytes: RUNTIME_LIMIT_DEFAULTS.toolAnswerBytes,
      sessionId: "s1",
      serverName: "files",
      serverToolName: "read.v2",
      args: {},
      manifest: agent.manifest,
    });
    expect(outcome).toEqual({ kind: "completed", output: "ok" });
    expect(remote.called).toEqual(["read.v2"]);
    await pool.close();
  });

  it("leaves out instructions past a record entry, and says so", async () => {
    const pool = new McpPool({
      openRemote: async () => ({ client: client(["read"]), instructions: "x".repeat(100), close: async () => {} }),
    });
    const found = await pool.discover({
      sessionId: "s1",
      manifest: agent.manifest,
      manifestHash: "h",
      maxInstructionBytes: 50,
    });
    expect(found.snapshot.servers[0]).not.toHaveProperty("instructions");
    expect(found.diagnostics[0]!.message).toContain("Its instructions are 100 bytes");
    await pool.close();
  });
});
