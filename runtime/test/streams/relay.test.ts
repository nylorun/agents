import { MemoryStreams } from "../../src/streams/memory.js";
import { relaySuite } from "./relay.suite.js";

relaySuite("memory streams", async () => ({ streams: new MemoryStreams() }));
