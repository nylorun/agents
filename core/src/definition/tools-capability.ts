import { z } from "zod";
import { tool } from "./helpers.js";
import { ToolError } from "./tool-error.js";
import { normalizedSchemasFor } from "./schema.js";
import type { CapabilityManifest, ToolManifest } from "../types/manifest.js";

/**
 * Id of the capability that holds `tool_search` and `tool_call` (R2b C10): the Runtime adds it at
 * session open to each agent with a remote MCP server, empty. When some of the agent's MCP tools
 * are deferred, the session's tools put `tool_search` and `tool_call` in it.
 */
export const TOOLS_CAPABILITY_ID = "nylorun.tools";
/** Finds deferred tools by a query (BM25 over their names and descriptions). */
export const TOOL_SEARCH_TOOL = "tool_search";
/** Runs a deferred tool by name, as a call of that tool. */
export const TOOL_CALL_TOOL = "tool_call";
/** How many tools `tool_search` returns when the model sets no `limit`. */
export const TOOL_SEARCH_DEFAULT_LIMIT = 8;
/** The most tools one `tool_search` returns. */
export const TOOL_SEARCH_MAX_LIMIT = 20;
/** How much of a server's own instructions the model sees in the deferred tools' note. */
export const SERVER_INSTRUCTIONS_MAX_CHARS = 2_000;

/** A server some of whose tools are deferred, as the model's note names it. */
export interface DeferredServerNote {
  readonly serverName: string;
  /** How many of its tools are deferred. */
  readonly tools: number;
  /** The server's own instructions (MCP `initialize`), if it gave any. */
  readonly instructions?: string;
}

async function toolsRuntimeOnly(): Promise<never> {
  throw new ToolError(
    "tools.runtime-only",
    "tool_search and tool_call run in the Nylorun Runtime. Connect the agent to a Runtime to use them."
  );
}

/** The capability the Runtime adds to an agent with a remote MCP server: empty, until tools are deferred. */
export function toolsCapabilityManifest(): CapabilityManifest {
  return {
    id: TOOLS_CAPABILITY_ID,
    type: "agent",
    description: "Deferred MCP tools: tool_search finds them and tool_call runs them.",
  };
}

/**
 * `tool_search` and `tool_call`, as the session gives them to an agent with deferred tools. Their
 * schemas reach the model; change them deliberately.
 */
export function deferredToolsTools(): readonly ToolManifest[] {
  return [searchTool(), callTool()].map((item): ToolManifest => {
    const schemas = normalizedSchemasFor(item);
    return {
      name: item.name,
      ...(item.description === undefined ? {} : { description: item.description }),
      inputSchema: schemas.inputSchema.jsonSchema,
    };
  });
}

/**
 * The note the model reads beside `tool_search`: each server with deferred tools, how many, and
 * its own instructions cut to `SERVER_INSTRUCTIONS_MAX_CHARS`.
 */
export function deferredToolsInstructions(servers: readonly DeferredServerNote[]): string {
  const lines = servers.map((server) => {
    const head = `- ${server.serverName}: ${server.tools} tool${server.tools === 1 ? "" : "s"}`;
    const text = server.instructions?.trim();
    if (!text) return head;
    const cut =
      text.length > SERVER_INSTRUCTIONS_MAX_CHARS
        ? `${text.slice(0, SERVER_INSTRUCTIONS_MAX_CHARS)}…`
        : text;
    return `${head}. The server says: ${cut}`;
  });
  return [
    "Some tools of these MCP servers are not in your tool list. Find them with tool_search (a few words of what you need), then run one with tool_call, passing its name and arguments that match its inputSchema.",
    ...lines,
  ].join("\n");
}

function searchTool() {
  return tool({
    name: TOOL_SEARCH_TOOL,
    description:
      "Search the tools not in your tool list by name and description. Returns the best matches, each with its name, description and inputSchema. Run one with tool_call.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Words of what the tool does, or of its name."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(TOOL_SEARCH_MAX_LIMIT)
        .optional()
        .describe(`How many tools to return. Default ${TOOL_SEARCH_DEFAULT_LIMIT}.`),
    }),
    effects: "read",
    execute: toolsRuntimeOnly,
  });
}

function callTool() {
  return tool({
    name: TOOL_CALL_TOOL,
    description:
      "Run a tool tool_search found, by its name. arguments must match that tool's inputSchema; the result is the tool's own.",
    inputSchema: z.object({
      name: z.string().min(1).describe("The tool's name, as tool_search returned it."),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The tool's arguments, matching its inputSchema. Default {}."),
    }),
    effects: "write",
    execute: toolsRuntimeOnly,
  });
}
