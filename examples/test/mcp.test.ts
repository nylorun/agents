import { codeToolRefusal, type AgentManifest } from "@nylorun/core/define";
import { expect, it } from "vitest";
import { createMcpAgent, DEEPWIKI_MCP_URL } from "../agents/mcp/agent.js";

it("declares DeepWiki as a remote MCP server and runs no code of its own", () => {
  const agent = createMcpAgent({ provider: "configured", model: "x" } as never);
  expect(agent.manifest.mcpServers).toEqual({
    deepwiki: expect.objectContaining({ name: "deepwiki", type: "streamable-http", url: DEEPWIKI_MCP_URL }),
  });
  expect(codeToolRefusal(agent.manifest as AgentManifest)).toBeUndefined();
});
