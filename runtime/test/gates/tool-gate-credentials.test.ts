/**
 * R2b C1 and C2: the credentials suite with every MCP and HTTP tool call made by a gates service
 * on 127.0.0.1, as in the local stack's gateway container: the gate reads the session row for
 * the identity header, sends to `via`, and carries a `401` back as `credential_rejected`.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../mcp-credentials.test.js");
