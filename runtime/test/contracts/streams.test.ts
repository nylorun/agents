import { expect, it } from "vitest";
import { MemoryStreams } from "../../src/streams/memory.js";
import { sessionStream } from "../../src/streams/types.js";
import { streamsContract } from "./streams.contract.js";

streamsContract("memory", async () => ({ streams: new MemoryStreams() }));

it("names a session's stream after the session", () => {
  expect(sessionStream("s:1")).toBe("sessions/s:1");
  expect(() => sessionStream("")).toThrow();
});

it("ends live readers when the Tenant is deleted", async () => {
  const streams = new MemoryStreams();
  await streams.ensureTenant("tn_x");
  const reading = (async () => {
    const seen: number[] = [];
    for await (const record of streams.read("tn_x", "tenant/control", 0)) seen.push(record.seq);
    return seen;
  })();
  await streams.append("tn_x", "tenant/control", [1]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await streams.deleteTenant("tn_x");
  expect(await reading).toEqual([0]);
});
