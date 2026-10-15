/**
 * Our engine's tool that stores a sandbox file, or inline text, as a file artifact of the session
 * (F8.1). Since protocol 15 it runs in our harness (`@nylorun/harness`), not the Runtime.
 */
export const SAVE_ARTIFACT_TOOL = "save_artifact";
/**
 * Our engine's tool that reads an artifact of the session in pages (R2b C11). Since protocol 15 it
 * runs in our harness; the Runtime still names it in a tool result's preview and in a file's
 * reference line, which our engine reads.
 */
export const READ_ARTIFACT_TOOL = "read_artifact";
/**
 * The inline cap of a tool result the Runtime shapes (R2b C11): 32 KiB, and the page our engine's
 * `read_artifact` reads by default.
 */
export const READ_ARTIFACT_MAX_BYTES = 32 * 1024;
/** Finds deferred tools by a query (BM25 over their names and descriptions). */
export const TOOL_SEARCH_TOOL = "tool_search";
/** Runs a deferred tool by name, as a call of that tool. */
export const TOOL_CALL_TOOL = "tool_call";
