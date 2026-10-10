/**
 * `tool_search` (R2b C10, Q20): core finds an agent's deferred MCP tools in the session's pinned
 * snapshot, ranked with BM25 over their names and descriptions, and returns each match's name,
 * description and `inputSchema`, for the model to run with `tool_call`. It reads only the pinned
 * snapshot, so the same query finds the same tools for the session's life; a tool the turn's
 * manifest disables is never found.
 */
import {
  TOOL_SEARCH_DEFAULT_LIMIT,
  TOOL_SEARCH_MAX_LIMIT,
  TOOL_SEARCH_TOOL,
  TOOLS_CAPABILITY_ID,
  type AgentManifest,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { isEnabledIn, type McpToolRecord } from "../mcp/snapshot.js";
import { sessionOf, type TenantContext } from "./context.js";
import { turnManifestOf } from "./session.js";

/** BM25's term saturation and length normalization, the usual values. */
const K1 = 1.2;
const B = 0.75;

/** True when `request` calls `tool_search` of the `nylorun.tools` capability `manifest` has. */
export function isToolSearchCall(manifest: AgentManifest | undefined, request: HostEffect): boolean {
  return (
    request.kind === "tool" &&
    request.capabilityId === TOOLS_CAPABILITY_ID &&
    request.toolName === TOOL_SEARCH_TOOL &&
    manifest?.capabilities.some((capability) => capability.id === TOOLS_CAPABILITY_ID) === true
  );
}

/** Runs `tool_search` for the run's agent. */
export async function callToolSearch(ctx: TenantContext, request: HostEffect) {
  const input = (request.input ?? {}) as { query?: unknown; limit?: unknown };
  const query = typeof input.query === "string" ? input.query : "";
  const limit =
    typeof input.limit === "number" && Number.isSafeInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), TOOL_SEARCH_MAX_LIMIT)
      : TOOL_SEARCH_DEFAULT_LIMIT;
  if (query.trim() === "")
    return { kind: "failed", code: "tools.invalid_input", message: "Give a query: words of what the tool does." };
  const session = await ctx.store.tx((t) => sessionOf(t, request.sessionId));
  const manifest = turnManifestOf(session);
  const deferred = (session.mcpSnapshot?.mcpTools ?? []).filter(
    (tool) =>
      tool.deferred === true &&
      tool.agentId === request.agent?.id &&
      // Enabled in the turn's manifest, which a variant may have tightened (R2b C9).
      isEnabledIn(manifest, tool)
  );
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
        ? { message: `No tool matches '${query}'. Try other words; ${deferred.length} tools are searchable.` }
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
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/**
 * The tools that match `query`, best first, by BM25 over each tool's name (counted twice, with
 * the server's own name for it) and description. A tool no word of the query is in is left out;
 * ties keep the snapshot's order.
 */
export function rank(tools: readonly McpToolRecord[], query: string): McpToolRecord[] {
  const words = [...new Set(tokens(query))];
  if (words.length === 0 || tools.length === 0) return [];
  const docs = tools.map((tool) => {
    const name = [...tokens(tool.name), ...tokens(tool.serverToolName)];
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
    })
  );
  return docs
    .map((doc, order) => {
      let score = 0;
      for (const word of words) {
        const tf = doc.counts.get(word) ?? 0;
        if (tf === 0) continue;
        score += idf.get(word)! * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / average)));
      }
      return { tool: doc.tool, score, order };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((item) => item.tool);
}
