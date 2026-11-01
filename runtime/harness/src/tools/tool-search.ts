/**
 * Deferred MCP tools (R2b C10, Q20), run by our engine: `tool_search` finds an agent's deferred
 * tools, ranked with BM25 over their names and descriptions, and returns each match's name,
 * description and `inputSchema`; `tool_call` runs one by name, as that tool's own call
 * (`deferredToolCall` in `run/durable.ts`). `tool_search` is our engine's tool (`harness`): it
 * reads only the run's MCP tools (`McpToolSet`), so the same query finds the same tools while the
 * session's layout stands; a tool the turn disables is never there.
 */
import { TOOL_SEARCH_TOOL } from "@nylorun/core/engine";
import type { DurableSessionTool, HostEffect } from "../run/durable.js";
import type { McpToolConfig } from "./mcp.js";

export {
  TOOL_CALL_TOOL,
  TOOL_SEARCH_TOOL,
  deferredToolsNote,
  deferredToolsTools,
  type DeferredServerNote,
} from "@nylorun/core/engine";

/** BM25's term saturation and length normalization, the usual values. */
const K1 = 1.2;
const B = 0.75;

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
