import { expect, it } from "vitest";
import {
  Agent,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
} from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { addPart } from "./support/parts.js";

it("fails the build when a part declares a sandbox", () => {
  expect(() =>
    addPart(Agent({ id: "analyst" }), {
      id: "sandbox",
      instructions: ["Use the sandbox."],
      sandbox: { image: "node:24" },
    } as never).build()
  ).toThrow(/Agents no longer declare a sandbox: open the session with it instead/);
});

it("refuses a sandbox in an agent manifest: the session keeps its sandbox (protocol 15)", () => {
  const base = { manifestSchemaVersion: 7 as const, id: "analyst" };
  expect(AgentManifestSchema.safeParse(base).success).toBe(true);
  expect(AgentManifestSchema.safeParse({ ...base, sandbox: {} }).success).toBe(false);
  expect(AgentManifestSchema.safeParse({ ...base, runtime: { sandbox: {} } }).success).toBe(false);
});

it("parses durations, sizes and host patterns", () => {
  expect(parseSandboxDuration("15m")).toBe(900_000);
  expect(parseSandboxDuration("0s")).toBeUndefined();
  expect(parseSandboxSize("2GiB")).toBe(2 * 1024 ** 3);
  expect(parseSandboxSize("2G")).toBeUndefined();
  expect(isSandboxHostPattern("api.github.com")).toBe(true);
  expect(isSandboxHostPattern("*.pythonhosted.org")).toBe(true);
  expect(isSandboxHostPattern("10.0.0.1")).toBe(false);
  expect(isSandboxHostPattern("localhost")).toBe(false);
  expect(isSandboxHostPattern("github.com/foo")).toBe(false);
});
