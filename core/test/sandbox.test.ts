import { expect, it } from "vitest";
import {
  Agent,
  SANDBOX_INSTRUCTIONS,
  createSandboxTools,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
  runtimeManifestFor,
} from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { addPart } from "./support/parts.js";

/** A session's pinned manifest: the definition plus the `runtime` block the Runtime adds. */
const pinned = (sandbox: Record<string, unknown> = {}) => ({
  manifestSchemaVersion: 7 as const,
  id: "analyst",
  runtime: runtimeManifestFor({}, { sandbox })!,
});

it("fails the build when a part declares a sandbox", () => {
  expect(() =>
    addPart(Agent({ id: "analyst" }), {
      id: "sandbox",
      instructions: [SANDBOX_INSTRUCTIONS],
      sandbox: { image: "node:24" },
    } as never).build()
  ).toThrow(/Agents no longer declare a sandbox: open the session with it instead/);
});

it("refuses the sandbox tools in an authored part: only the Runtime pins them", () => {
  expect(() =>
    addPart(Agent({ id: "analyst" }), { id: "sandbox", tools: createSandboxTools() }).build()
  ).toThrow(/Tool 'bash' takes the name of a tool the Runtime serves/);
});

it("rejects unknown fields and bad values in the pinned sandbox on the wire", () => {
  const base = pinned();
  const withSandbox = (sandbox: unknown) =>
    AgentManifestSchema.safeParse({ ...base, runtime: { ...base.runtime, sandbox } }).success;
  expect(withSandbox({ setup: ["pip install pandas"] })).toBe(false);
  expect(withSandbox({ idle: "soon" })).toBe(false);
  expect(withSandbox({ resources: { memory: "2GB" } })).toBe(false);
  expect(withSandbox({ network: { preset: "all" } })).toBe(false);
  expect(withSandbox({ network: { allow: ["https://api.github.com"] } })).toBe(false);
  expect(withSandbox({ network: { allow: ["*.github.com"] }, resources: { memory: "2GiB" } })).toBe(true);
});

it("refuses a sandbox anywhere but runtime", () => {
  expect(AgentManifestSchema.safeParse({ ...pinned(), sandbox: {} }).success).toBe(false);
  expect(
    AgentManifestSchema.safeParse({ ...pinned(), runtime: { ...pinned().runtime, extra: true } }).success
  ).toBe(false);
});

it("fails the developer-process stub with a teaching error", async () => {
  const bash = createSandboxTools()[0]!;
  await expect((bash.execute as any)({ command: "ls" }, {})).rejects.toMatchObject({
    code: "sandbox.runtime-only",
  });
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
