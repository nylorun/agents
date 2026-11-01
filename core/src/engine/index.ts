/**
 * `@nylorun/core/engine`: what our engine adds to an agent (protocol 15, ADR-100), in one place
 * the compiler, the harness and the SDK share: the text blocks by name and version, the
 * definitions of our engine's own tools, the MCP tools' naming and deferral, the projection of
 * both for one agent, and `previewTurn`.
 */
export * from "./names.js";
export * from "./blocks.js";
export * from "./features.js";
export * from "./tools.js";
export * from "./mcp.js";
export * from "./projection.js";
export * from "./preview.js";
export * from "./explain.js";
