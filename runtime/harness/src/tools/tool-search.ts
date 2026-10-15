/**
 * Deferred MCP tools (R2b C10, Q20), run by our engine: `tool_search` finds an agent's deferred
 * tools, ranked with BM25 over their names and descriptions, and returns each match's name,
 * description and `inputSchema`; `tool_call` runs one by name, as that tool's own call
 * (`deferredToolCall` in `run/durable.ts`). `tool_search` is our engine's tool (`harness`): it
 * reads only the run's MCP tools (`McpToolSet`), so the same query finds the same tools while the
 * session's layout stands; a tool the turn disables is never there.
 */
import { z } from "zod";
import { normalizedSchemasFor, tool, ToolError, type ToolManifest } from "@nylorun/core/define";
import type { EffectTarget } from "@nylorun/core/harness-api";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";
import type { McpToolConfig } from "./mcp.js";

/** Finds deferred tools by a query (BM25 over their names and descriptions). */
export const TOOL_SEARCH_TOOL = "tool_search";
/** Runs a deferred tool by name, as a call of that tool. */
export const TOOL_CALL_TOOL = "tool_call";

/** BM25's term saturation and length normalization, the usual values. */
const K1 = 1.2;
const B = 0.75;

const HARNESS: EffectTarget = Object.freeze({ kind: "harness" });

/** A server some of whose tools are deferred, as the model's note names it. */
export interface DeferredServerNote {
  readonly serverName: string;
  /** How many of its tools are deferred. */
  readonly tools: number;
  /** The server's own instructions (MCP `initialize`), if it gave any. */
  readonly instructions?: string;
}

async function runsInHarness(): Promise<never> {
  throw new ToolError(
    "tools.runtime-only",
    "tool_search and tool_call run in Nylorun's harness. Connect the agent to a Runtime to use them.",
  );
}

/**
 * `tool_search` (ours, `harness`) and `tool_call`, as our engine gives them to an agent with
 * deferred tools. Their schemas reach the model; change them deliberately.
 */
export function deferredToolsTools(
  config: Pick<McpToolConfig, "toolSearchDefaultLimit" | "toolSearchMaxLimit">,
): readonly DurableSessionTool[] {
  return [searchTool(config), callTool()].map((item, index): DurableSessionTool => {
    const schemas = normalizedSchemasFor(item);
    const manifest: ToolManifest = {
      name: item.name,
      ...(item.description === undefined ? {} : { description: item.description }),
      inputSchema: schemas.inputSchema.jsonSchema,
    };
    // `tool_call` makes the effect of the tool it names; it is never one itself.
    return index === 0 ? { ...manifest, target: HARNESS } : manifest;
  });
}

/**
 * The note the model reads beside `tool_search`: each server with deferred tools, how many, and
 * its own instructions cut to `config.serverInstructionsMaxChars`.
 */
export function deferredToolsNote(
  servers: readonly DeferredServerNote[],
  config: Pick<McpToolConfig, "serverInstructionsMaxChars">,
): string {
  const max = config.serverInstructionsMaxChars;
  const lines = servers.map((server) => {
    const head = `- ${server.serverName}: ${server.tools} tool${server.tools === 1 ? "" : "s"}`;
    const text = server.instructions?.trim();
    if (!text) return head;
    const cut = text.length > max ? `${text.slice(0, max)}…` : text;
    return `${head}. The server says: ${cut}`;
  });
  return [
    "Some tools of these MCP servers are not in your tool list. Find them with tool_search (a few words of what you need), then run one with tool_call, passing its name and arguments that match its inputSchema.",
    ...lines,
  ].join("\n");
}

function searchTool(config: Pick<McpToolConfig, "toolSearchDefaultLimit" | "toolSearchMaxLimit">) {
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
        .max(config.toolSearchMaxLimit)
        .optional()
        .describe(`How many tools to return. Default ${config.toolSearchDefaultLimit}.`),
    }),
    effects: "read",
    execute: runsInHarness,
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
    execute: runsInHarness,
  });
}

/** True when `effect` calls our engine's `tool_search`. */
export function isToolSearch(effect: Pick<HostEffect, "toolName" | "target">): boolean {
  return effect.target?.kind === "harness" && effect.toolName === TOOL_SEARCH_TOOL;
}

/** Runs `tool_search` over `deferred`, the deferred tools of the call's agent. */
export function runToolSearch(
  effect: Pick<HostEffect, "input">,
  deferred: readonly DurableSessionTool[],
  config: Pick<McpToolConfig, "toolSearchDefaultLimit" | "toolSearchMaxLimit">,
) {
  const input = (effect.input ?? {}) as { query?: unknown; limit?: unknown };
  const query = typeof input.query === "string" ? input.query : "";
  const limit =
    typeof input.limit === "number" && Number.isSafeInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), config.toolSearchMaxLimit)
      : config.toolSearchDefaultLimit;
  if (query.trim() === "")
    return {
      kind: "failed",
      code: "tools.invalid_input",
      message: "Give a query: words of what the tool does.",
    };
  const found = rank(deferred, query).slice(0, limit);
  return {
    kind: "completed",
    output: {
      tools: found.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      })),
      ...(found.length === 0
        ? {
            message: `No tool matches '${query}'. Try other words; ${deferred.length} tools are searchable.`,
          }
        : {}),
    },
  };
}

/**
 * Lower-case words of `text`: `camelCase`, `snake_case` and `kebab-case` split into words, and a
 * plural `s` dropped (`issues` finds `issue`).
 */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word,
    );
}

/**
 * The tools that match `query`, best first, by BM25 over each tool's name (counted twice, with
 * the server's own name for it) and description. A tool no word of the query is in is left out;
 * ties keep the given order.
 */
export function rank(tools: readonly DurableSessionTool[], query: string): DurableSessionTool[] {
  const words = [...new Set(tokens(query))];
  if (words.length === 0 || tools.length === 0) return [];
  const docs = tools.map((tool) => {
    const own = tool.target?.kind === "mcp" ? tool.target.tool : "";
    const name = [...tokens(tool.name), ...tokens(own)];
    const terms = [...name, ...name, ...tokens(tool.description ?? "")];
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    return { tool, counts, length: terms.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const idf = new Map(
    words.map((word) => {
      const df = docs.filter((doc) => doc.counts.has(word)).length;
      return [word, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
    }),
  );
  return docs
    .map((doc, order) => {
      let score = 0;
      for (const word of words) {
        const tf = doc.counts.get(word) ?? 0;
        if (tf === 0) continue;
        score +=
          idf.get(word)! * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / average)));
      }
      return { tool: doc.tool, score, order };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((item) => item.tool);
}
