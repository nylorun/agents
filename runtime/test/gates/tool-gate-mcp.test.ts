/**
 * F4.1: the MCP suite with remote servers behind the Tool Gate. Each Tenant's remote MCP
 * connections, their vault credentials and OAuth refresh live in a gates service on 127.0.0.1,
 * as in the local stack's gateway container; stdio servers still run beside the loop.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../mcp.test.js");
