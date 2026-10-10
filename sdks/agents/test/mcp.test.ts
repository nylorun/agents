import { Agent } from "@nylorun/core/define";
import { AgentManifestSchema } from "@nylorun/core/contracts";
import { expect, it } from "vitest";
import { mcp, McpError } from "../src/mcp/index.js";

const github = {
  name: "github",
  type: "streamable-http" as const,
  url: "https://mcp.example.com/github",
};

it("builds a capability for Agent.use from an mcpServers map", () => {
  const declaration = mcp({
    github: {
      ...github,
      headers: { "X-Tenant": "public" },
    },
  });
  expect(declaration).toMatchObject({
    id: "mcp",
    mcpServers: {
      github: {
        name: "github",
        type: "streamable-http",
        url: "https://mcp.example.com/github",
        headers: { "X-Tenant": "public" },
      },
    },
  });

  const agent = Agent({
    id: "assistant",
    name: "Order assistant",
    instructions: "Use lookup_order for orders.",
  })
    .use(mcp({ github }))
    .build();

  expect(
    agent.manifest.capabilities.find((item) => item.id === "mcp")
  ).toMatchObject({
    id: "mcp",
    type: "agent",
    mcpServers: { github },
  });
});

it("accepts the sse transport and an explicit capability id", () => {
  const declaration = mcp(
    {
      legacy: {
        name: "legacy",
        type: "sse",
        url: "https://mcp.example.com/sse",
      },
    },
    { id: "integrations" }
  );
  expect(declaration.id).toBe("integrations");
  expect(Object.keys(declaration.mcpServers)).toEqual(["legacy"]);

  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use(
      mcp(
        {
          github,
          legacy: { type: "sse", url: "https://mcp.example.com/sse" },
        },
        { id: "integrations" }
      )
    )
    .build();
  expect(
    agent.manifest.capabilities.find((item) => item.id === "integrations")
  ).toMatchObject({
    id: "integrations",
    mcpServers: {
      github,
      legacy: { name: "legacy", type: "sse", url: "https://mcp.example.com/sse" },
    },
  });
});

it("refuses a stdio server", () => {
  expect(() =>
    mcp({ local: { type: "stdio", command: "./bin/tools" } } as never)
  ).toThrow(
    "MCP server 'local' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL."
  );
});

it("composes with the existing .use({ id, mcpServers }) pattern", () => {
  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use({
      id: "inline",
      mcpServers: {
        docs: {
          name: "docs",
          type: "streamable-http",
          url: "https://mcp.example.com/docs",
        },
      },
    })
    .use(mcp({ github }, { id: "github-mcp" }))
    .build();

  expect(
    agent.manifest.capabilities
      .filter((item) => item.mcpServers)
      .map((item) => item.id)
      .sort()
  ).toEqual(["github-mcp", "inline"]);
  expect(
    agent.manifest.capabilities.find((item) => item.id === "github-mcp")
      ?.mcpServers
  ).toEqual({ github });
});

it("rejects an empty map, a name mismatch, and an invalid server", () => {
  expect(() => mcp({})).toThrow(McpError);
  try {
    mcp({});
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe("mcp.empty");
  }

  expect(() =>
    mcp({
      other: github,
    })
  ).toThrow(/must equal the server name/);
  try {
    mcp({ other: github });
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe("mcp.name-mismatch");
  }

  expect(() =>
    mcp({
      broken: { name: "broken", type: "streamable-http" } as never,
    })
  ).toThrow(McpError);
});

it("produces a manifest schema that rejects duplicate MCP server names", () => {
  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use(mcp({ github }, { id: "one" }))
    .use(mcp({ github }, { id: "two" }))
    .build();
  const parsed = AgentManifestSchema.safeParse(agent.manifest);
  expect(parsed.success).toBe(false);
});
