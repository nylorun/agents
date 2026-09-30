import { expect, it } from "vitest";
import { MemoryStreams } from "../../src/streams/memory.js";
import {
  newStreamIncarnation,
  parseSessionStream,
  sessionStream,
  streamOfSession,
} from "../../src/streams/types.js";
import { streamsContract } from "./streams.contract.js";

streamsContract("memory", async () => ({ streams: new MemoryStreams() }));

it("names session streams by incarnation and maps them back", () => {
  expect(parseSessionStream(sessionStream("s:1", "abc"))).toEqual({
    sessionId: "s:1",
    incarnation: "abc",
  });
  expect(parseSessionStream("tenant/control")).toBeUndefined();
  expect(parseSessionStream("sessions/")).toBeUndefined();
  expect(parseSessionStream("sessions/s1")).toBeUndefined();
  expect(parseSessionStream("sessions/s1/")).toBeUndefined();
  expect(() => sessionStream("", "abc")).toThrow();
  expect(() => sessionStream("s1", "")).toThrow();
  expect(() => sessionStream("s1", "a/b")).toThrow();
  const incarnation = newStreamIncarnation();
  expect(incarnation).toMatch(/^[A-Za-z0-9_-]{12}$/);
  expect(newStreamIncarnation()).not.toBe(incarnation);
  expect(streamOfSession({ id: "s1", streamIncarnation: incarnation })).toBe(
    `sessions/s1/${incarnation}`,
  );
  // Sessions written before incarnations.
  expect(streamOfSession({ id: "s1" })).toBe("sessions/s1/0");
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
