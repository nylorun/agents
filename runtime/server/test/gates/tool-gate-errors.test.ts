/**
 * R2b C6, C7 and C8: the MCP errors suite with every MCP and HTTP tool call made by a gates
 * service on 127.0.0.1, as in the local stack's gateway container: the gate codes each failure,
 * scrubs credential values before it records or returns an answer, and the loop reads both.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../mcp-errors.test.js");
