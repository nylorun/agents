/**
 * R2 M3: the HTTP tool suite with every HTTP tool call made by a gates service on 127.0.0.1, as
 * in the local stack's gateway container: the gate finds the tool in the session's pinned
 * manifest, adds the vault credential and runs a keyed call once.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../http-tools.test.js");
