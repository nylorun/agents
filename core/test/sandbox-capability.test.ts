import { expect, it } from "vitest";
import { AgentManifestSchema } from "../src/contracts.js";
import {
  Agent,
  SANDBOX_CAPABILITY_ID,
  SANDBOX_TOOL_NAMES,
  canonical,
  sandboxCapabilityManifest,
} from "../src/define.js";

const spec = { network: { preset: "none" as const, allow: ["api.github.com"] }, idle: "15m" };

it("builds the capability the Runtime adds to a session with a sandbox", () => {
  const capability = sandboxCapabilityManifest(spec);
  expect(capability.id).toBe(SANDBOX_CAPABILITY_ID);
  expect(capability.sandbox).toEqual(spec);
  expect(capability.tools?.map((tool) => tool.name)).toEqual([...SANDBOX_TOOL_NAMES]);
  const manifest = { manifestSchemaVersion: 4, id: "bot", capabilities: [capability] };
  expect(AgentManifestSchema.safeParse(manifest).success).toBe(true);
});

it("carries the same tools and instructions a declared sandbox carries", () => {
  const declared = Agent({ id: "bot" }).sandbox(spec).build().manifest.capabilities[0]!;
  expect(canonical({ ...sandboxCapabilityManifest(spec), id: declared.id })).toBe(
    canonical(declared)
  );
});
