import { expect, it } from "vitest";
import {
  Agent,
  SANDBOX_INSTRUCTIONS,
  createSandboxTools,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
  sandboxCapabilityManifest,
} from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";

/** A session's pinned manifest: the definition plus the capability the Runtime adds. */
const pinned = (sandbox: Record<string, unknown> = {}) => ({
  manifestSchemaVersion: 4 as const,
  id: "analyst",
  capabilities: [sandboxCapabilityManifest(sandbox)],
});

it("fails the build when a capability declares a sandbox", () => {
  expect(() =>
    Agent({ id: "analyst" })
      .capability({
        id: "sandbox",
        instructions: [SANDBOX_INSTRUCTIONS],
        tools: createSandboxTools(),
        sandbox: { image: "node:24" },
      } as never)
      .build()
  ).toThrow(/declares a sandbox\. Agents no longer declare one/);
});

it("rejects unknown fields, bad values and missing built-in tools on the wire", () => {
  const base = pinned();
  const withSandbox = (sandbox: unknown) =>
    AgentManifestSchema.safeParse({
      ...base,
      capabilities: [{ ...base.capabilities[0], sandbox }],
    }).success;
  expect(withSandbox({ setup: ["pip install pandas"] })).toBe(false);
  expect(withSandbox({ idle: "soon" })).toBe(false);
  expect(withSandbox({ resources: { memory: "2GB" } })).toBe(false);
  expect(withSandbox({ network: { preset: "all" } })).toBe(false);
  expect(withSandbox({ network: { allow: ["https://api.github.com"] } })).toBe(false);
  expect(withSandbox({ network: { allow: ["*.github.com"] }, resources: { memory: "2GiB" } })).toBe(true);
  const missing = AgentManifestSchema.safeParse({
    ...base,
    capabilities: [
      {
        ...base.capabilities[0],
        tools: base.capabilities[0]!.tools!.filter((item) => item.name !== "bash"),
      },
    ],
  });
  expect(missing.success).toBe(false);
});

it("rejects two sandbox capabilities", () => {
  const base = pinned();
  const result = AgentManifestSchema.safeParse({
    ...base,
    capabilities: [base.capabilities[0], { id: "second", type: "agent", sandbox: {} }],
  });
  expect(result.success).toBe(false);
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
