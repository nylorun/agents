/**
 * #496: the workload token suite with every MCP and model call made by a gates service on
 * 127.0.0.1, as in the local stack's gateway container, which reads the token file itself.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../workload-token.test.js");
