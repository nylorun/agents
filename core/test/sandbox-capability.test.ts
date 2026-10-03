import { expect, it } from "vitest";
import { AgentManifestSchema, MessageEventBodySchema } from "../src/contracts.js";
import {
  ARTIFACTS_CAPABILITY_ID,
  SAVE_ARTIFACT_TOOL,
  artifactsCapabilityManifest,
  SANDBOX_CAPABILITY_ID,
  SANDBOX_INSTRUCTIONS,
  SANDBOX_TOOL_NAMES,
  sandboxCapabilityManifest,
} from "../src/define.js";

const spec = { network: { preset: "none" as const, allow: ["api.github.com"] }, idle: "15m" };

it("builds the save_artifact capability that comes with a sandbox", () => {
  const capability = artifactsCapabilityManifest();
  expect(capability.id).toBe(ARTIFACTS_CAPABILITY_ID);
  expect(capability.tools?.map((tool) => tool.name)).toEqual([SAVE_ARTIFACT_TOOL]);
  expect(Object.keys(capability.tools![0]!.inputSchema.properties as object)).toEqual([
    "path",
    "content",
    "name",
    "contentType",
    "artifactId",
  ]);
  const manifest = {
    manifestSchemaVersion: 4,
    id: "bot",
    capabilities: [sandboxCapabilityManifest(spec), capability],
  };
  expect(AgentManifestSchema.safeParse(manifest).success).toBe(true);
});

it("takes message parts: text, and files by artifact id (protocol 6)", () => {
  const base = { type: "message", requestId: "r", idempotencyKey: "k" } as const;
  expect(
    MessageEventBodySchema.safeParse({
      ...base,
      parts: [
        { type: "text", text: "look" },
        { type: "file", artifactId: "af_00000000000000000000000000", version: 2 },
      ],
    }).success,
  ).toBe(true);
  expect(MessageEventBodySchema.safeParse({ ...base, parts: [] }).success).toBe(false);
  expect(
    MessageEventBodySchema.safeParse({ ...base, content: "x", parts: [{ type: "text", text: "y" }] })
      .success,
  ).toBe(false);
  expect(
    MessageEventBodySchema.safeParse({ ...base, parts: [{ type: "file", bytes: "AAAA" }] }).success,
  ).toBe(false);
});

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
