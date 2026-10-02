/**
 * F4.1: the Action delivery suites with every delivery and ping POSTed by the Tool Gate in a
 * gates service on 127.0.0.1, as in the local stack's gateway container.
 */
process.env.NYLORUN_TEST_MODEL_GATE = "http";
await import("../delivery.test.js");
await import("../delivery-results.test.js");
await import("../endpoints.test.js");
