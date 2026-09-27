import { describe } from "vitest";
import { createS2Streams } from "../../src/adapters/streams/s2.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";
import { relaySuite } from "./relay.suite.js";

describe.skipIf(!STACK_ENABLED)("s2-lite", () => {
  relaySuite("s2-lite", async () => ({
    streams: createS2Streams({
      endpoint: stackEndpoints().s2.endpoint,
      basinPrefix: "relay-",
    }),
  }));
});
