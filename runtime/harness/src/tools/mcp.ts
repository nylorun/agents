/**
 * The session's MCP tools as our engine offers them (protocol 15): named, deferred behind
 * `tool_search` past the threshold (only for an agent that declares tool search, ADR-100, or
 * declares nothing), and laid out once per session's facts. The code is `@nylorun/core/engine`'s,
 * which the SDK's `previewTurn` runs too.
 */
export {
  DEFAULT_MCP_TOOL_CONFIG,
  MODEL_TOOL_NAME_MAX,
  mcpToolConfigOf,
  mcpToolKey,
  mcpToolName,
  mcpToolNames,
  mcpToolSet,
  type McpLayout,
  type McpRenamedTool,
  type McpToolConfig,
  type McpToolDiagnostic,
  type McpToolSet,
} from "@nylorun/core/engine";
