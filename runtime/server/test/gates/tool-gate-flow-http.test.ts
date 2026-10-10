/**
 * HTTP in flows with every HTTP stage and HTTP verifier request made by a gates service on
 * 127.0.0.1, as in the local stack's gateway container: the gate finds the stage in the flow
 * session's pinned workflow manifest by its stage key.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../flow-http.test.js");
