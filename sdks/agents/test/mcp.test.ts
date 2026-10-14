import { Agent } from "@nylorun/core/define";
import { AgentManifestSchema } from "@nylorun/core/contracts";
import { expect, it } from "vitest";
import { McpError, normalizeMcpServers } from "../src/mcp/index.js";

const github = {
  name: "github",
  type: "streamable-http" as const,
  url: "https://mcp.example.com/github",
};

it("declares servers with .mcp()", () => {
  const agent = Agent({
    id: "assistant",
    name: "Order assistant",
    instructions: "Use lookup_order for orders.",
  })
    .mcp({ github: { ...github, headers: { "X-Tenant": "public" } } })
    .build();

  expect(agent.manifest).toMatchObject({
    mcpServers: {
      github: {
        name: "github",
        type: "streamable-http",
        url: "https://mcp.example.com/github",
        headers: { "X-Tenant": "public" },
      },
    },
  });
});

it("accepts the sse transport and merges .mcp() calls", () => {
  const agent = Agent({ id: "assistant", instructions: "Help." })
    .mcp({ github })
    .mcp({ legacy: { type: "sse", url: "https://mcp.example.com/sse" } })
    .build();
  expect(agent.manifest.mcpServers).toEqual({
    github,
    legacy: { name: "legacy", type: "sse", url: "https://mcp.example.com/sse" },
  });
});

it("refuses a stdio server", () => {
  expect(() =>
    Agent({ id: "assistant" }).mcp({ local: { type: "stdio", command: "./bin/tools" } } as never)
  ).toThrow(
    "MCP server 'local' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL."
  );
});

it("rejects an empty map, a name mismatch, and an invalid server", () => {
  expect(() => normalizeMcpServers({}, ".mcp()")).toThrow(McpError);
  try {
    normalizeMcpServers({}, ".mcp()");
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe("mcp.empty");
  }

  expect(() => normalizeMcpServers({ other: github }, ".mcp()")).toThrow(
    /must equal the server name/
  );
  try {
    normalizeMcpServers({ other: github }, ".mcp()");
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe("mcp.name-mismatch");
  }

  expect(() =>
    normalizeMcpServers(
      { broken: { name: "broken", type: "streamable-http" } as never },
      ".mcp()"
    )
  ).toThrow(McpError);
});

it("refuses the same server declared twice", () => {
  expect(() =>
    Agent({ id: "assistant", instructions: "Help." }).mcp({ github }).mcp({ github }).build()
  ).toThrow(/declared twice/);
  const agent = Agent({ id: "assistant", instructions: "Help." }).mcp({ github }).build();
  expect(AgentManifestSchema.safeParse(agent.manifest).success).toBe(true);
});
