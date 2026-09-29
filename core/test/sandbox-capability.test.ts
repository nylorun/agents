import { expect, it } from "vitest";
import { AgentManifestSchema } from "../src/contracts.js";
import {
  SANDBOX_CAPABILITY_ID,
  SANDBOX_INSTRUCTIONS,
  SANDBOX_TOOL_NAMES,
  sandboxCapabilityManifest,
} from "../src/define.js";

const spec = { network: { preset: "none" as const, allow: ["api.github.com"] }, idle: "15m" };

it("builds the capability the Runtime adds to a session with a sandbox", () => {
  const capability = sandboxCapabilityManifest(spec);
  expect(capability.id).toBe(SANDBOX_CAPABILITY_ID);
  expect(capability.sandbox).toEqual(spec);
  expect(capability.tools?.map((tool) => tool.name)).toEqual([...SANDBOX_TOOL_NAMES]);
  expect(capability.instructions).toEqual([SANDBOX_INSTRUCTIONS]);
  expect(capability.tools?.every((tool) => tool.description && tool.inputSchema)).toBe(true);
  const manifest = { manifestSchemaVersion: 4, id: "bot", capabilities: [capability] };
  expect(AgentManifestSchema.safeParse(manifest).success).toBe(true);
});
