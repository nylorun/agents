/**
 * F4.1: the MCP suite with remote servers behind the Tool Gate. Each Tenant's remote MCP
 * connections and their vault credentials live in a gates service on 127.0.0.1,
 * as in the local stack's gateway container.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../mcp.test.js");
