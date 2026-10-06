import { Agent } from "@nylorun/agents/define";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** DeepWiki's public MCP server: answers questions about public GitHub repositories, no key. */
export const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";

/**
 * MCP is a remote server declared by URL. The Runtime connects to it through its gates and
 * offers its tools to the model; nothing of yours runs during the session.
 */
export function createMcpAgent(deps: AgentDependencies): ExampleAgent {
  return Agent({
    id: "mcp",
    name: "Remote MCP",
    description: "Answers questions about a public GitHub repository through DeepWiki's MCP server.",
  })
    .instructions(
      exampleInstructions,
      "Use the deepwiki tools for questions about a public GitHub repository, named as owner/repo.",
    )
    .mcp({ deepwiki: { type: "streamable-http", url: DEEPWIKI_MCP_URL } })
    .capability(modelSelection(deps.provider, deps.model))
    .build();
}
