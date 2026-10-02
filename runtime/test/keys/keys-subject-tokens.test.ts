/**
 * F4.2: the subject token suite with every token signed by the keys service in a gates service
 * on 127.0.0.1, as in the local stack's gateway container.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../security/subject-tokens.test.js");
