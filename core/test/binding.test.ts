import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, AgentBuildError, hashManifest, tool } from "../src/define.js";
import { addPart } from "./support/parts.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";
it("keeps live code and schemas in a non-serialized binding", () => {
  const run = async ({ value }: { value: number }) => value;
  const outputSchema = z.object({ value: z.number() });
  const agent = Agent({
    id: "binding",
    name: "Binding",
    outputSchema,
    tools: [
      tool({ name: "value", input: z.object({ value: z.number() }), run }),
    ],
  }).build();
  const binding = agent.getBinding();
  expect(Object.keys(agent)).not.toContain("getBinding");
  expect(JSON.parse(JSON.stringify(agent))).toEqual(agent.manifest);
  expect(binding.outputSchema).toBe(outputSchema);
  expect(binding.manifest).toBe(agent.manifest);
  expect(typeof binding.implementations.agent.tools?.value.execute).toBe(
    "function"
  );
  expect(binding.declarations.map((d) => d.id)).toEqual(["agent"]);
  expect(Object.isFrozen(binding)).toBe(true);
});

it("projects optional description and metadata onto the manifest", () => {
  const plain = Agent({ id: "plain", name: "Plain" }).build();
  expect(plain.manifest).not.toHaveProperty("description");
  expect(plain.manifest).not.toHaveProperty("metadata");

  const metadata = { owner: "support", tags: ["orders"] };
  const builder = Agent({
    id: "described",
    name: "Described",
    description: "Looks up orders.",
    metadata,
  });
  expect(builder.manifest.description).toBe("Looks up orders.");
  expect(builder.manifest.metadata).toEqual(metadata);
  expect(builder.manifest.metadata).not.toBe(metadata);
  expect(Object.isFrozen(builder.manifest.metadata)).toBe(true);

  const extended = addPart(builder, { id: "extra", instructions: ["Extra."] });
  expect(extended.manifest.description).toBe("Looks up orders.");
  expect(extended.manifest.metadata).toEqual(metadata);
  expect(hashManifest(extended.manifest)).not.toBe(hashManifest(builder.manifest));

  const agent = builder.build();
  const json = agent.toJSON();
  expect(AgentManifestSchema.safeParse(json).success).toBe(true);
  const restored = Agent.from(json, {});
  expect(restored.manifest).toEqual(agent.manifest);
  expect(hashManifest(restored.manifest)).toBe(hashManifest(agent.manifest));
  expect(hashManifest({ ...agent.manifest, description: "Other." })).not.toBe(
    hashManifest(agent.manifest)
  );

  expect(() => Agent.from({ ...json, description: 1 }, {})).toThrow(
    HarnessError
  );
});

it("omits an unset agent name and projects capability name and description", () => {
  const unnamed = Agent({ id: "unnamed" }).build();
  expect(unnamed.name).toBeUndefined();
  expect(unnamed.manifest).not.toHaveProperty("name");
  expect(AgentManifestSchema.safeParse(unnamed.toJSON()).success).toBe(true);

  const agent = addPart(Agent({ id: "support" }), {
    id: "orders",
    name: "Orders",
    description: "Looks up orders.",
    instructions: ["Look up first."],
  }).build();
  expect(agent.manifest.capabilities).toEqual([
    expect.objectContaining({
      id: "orders",
      name: "Orders",
      description: "Looks up orders.",
    }),
  ]);
  const json = agent.toJSON();
  expect(AgentManifestSchema.safeParse(json).success).toBe(true);
  const restored = Agent.from(json, {});
  expect(restored.manifest).toEqual(agent.manifest);
  expect(hashManifest(restored.manifest)).toBe(hashManifest(agent.manifest));

  const labelOnly = addPart(Agent({ id: "labeled" }), {
    id: "label",
    name: "Label",
    description: "Just a label.",
  }).build();
  expect(labelOnly.manifest.capabilities[0]).toEqual({
    id: "label",
    type: "agent",
    name: "Label",
    description: "Just a label.",
  });

  expect(() => Agent({ id: "a", name: "" }).build()).toThrow(AgentBuildError);
  expect(() =>
    addPart(Agent({ id: "a" }), { id: "orders", name: "" }).build()
  ).toThrow(AgentBuildError);
});
