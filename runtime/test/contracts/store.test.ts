import { expect, it } from "vitest";
import { MemorySessionStore } from "../../src/store/memory.js";
import { decodeCursor, encodeCursor } from "../../src/record/index.js";
import { storeContract } from "./store.contract.js";

storeContract("memory", async (options) => ({
  store: new MemorySessionStore(options),
}));

it("encodes cursors as base64url session:seq", () => {
  expect(encodeCursor("s1", 7)).toBe(Buffer.from("s1:7").toString("base64url"));
  expect(decodeCursor("s1", encodeCursor("s1", 7))).toBe(7);
  expect(() => decodeCursor("s2", encodeCursor("s1", 7))).toThrow("Invalid cursor");
  expect(() => decodeCursor("s1", Buffer.from("s1:x").toString("base64url"))).toThrow(
    "Invalid cursor",
  );
});

it("rejects transactions after close", async () => {
  const store = new MemorySessionStore({ tenantId: "tn_test" });
  await store.close();
  await expect(store.tx(async () => 1)).rejects.toThrow("closed");
});
