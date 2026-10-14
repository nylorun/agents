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
  expect(typeof binding.implementations.tools?.value.execute).toBe(
    "function"
  );
  expect(binding.parts.map((d) => d.id)).toEqual(["agent"]);
  expect(binding.tools[0]!.owner).toMatchObject({ partId: "agent" });
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

it("omits an unset agent name and merges its parts into the flat manifest", () => {
  const unnamed = Agent({ id: "unnamed" }).build();
  expect(unnamed.name).toBeUndefined();
  expect(unnamed.manifest).not.toHaveProperty("name");
  expect(AgentManifestSchema.safeParse(unnamed.toJSON()).success).toBe(true);

  const lookup = tool({ name: "lookup", input: z.object({}), run: async () => "ok" });
  const agent = addPart(Agent({ id: "support" }).instructions("Help."), {
    id: "orders",
    instructions: ["Look up first."],
    tools: [lookup],
  }).build();
  expect(agent.manifest).toEqual({
    manifestSchemaVersion: 7,
    id: "support",
    instructions: ["Help.", "Look up first."],
    tools: [expect.objectContaining({ name: "lookup" })],
  });
  expect(agent.getBinding().parts.map((part) => part.id)).toEqual(["agent", "orders"]);
  const json = agent.toJSON();
  expect(AgentManifestSchema.safeParse(json).success).toBe(true);
  const restored = Agent.from(json, { tools: { lookup } });
  expect(restored.manifest).toEqual(agent.manifest);
  expect(hashManifest(restored.manifest)).toBe(hashManifest(agent.manifest));
  // Rebuilt, the manifest is one part: the agent's.
  expect(restored.getBinding().parts.map((part) => part.id)).toEqual(["agent"]);
  expect(() => Agent.from(json, {})).toThrow(/Missing tool implementation 'lookup'/);

  expect(() => Agent({ id: "a", name: "" }).build()).toThrow(AgentBuildError);
  expect(() => addPart(Agent({ id: "a" }), { id: "" }).build()).toThrow(AgentBuildError);
  expect(() =>
    addPart(addPart(Agent({ id: "a" }), { id: "same" }), { id: "same" }).build()
  ).toThrow(/'same' is added twice/);
});

it("projects .mcp() and a raw part flat, with plugin labels and no skill tools", () => {
  const SKILL_MD = `sha256:${"a".repeat(64)}`;
  const label = { name: "ops", version: "2.1.0" };
  const agent = addPart(
    Agent({ id: "support" })
      .instructions("Help.")
      .mcp({ linear: { type: "streamable-http", url: "https://mcp.example.com/linear" } }),
    {
      id: "plugin:ops",
      instructions: ["Follow the runbook."],
      skills: {
        deploy: { name: "deploy", description: "Deploy a service.", files: { "SKILL.md": SKILL_MD }, plugin: label },
      },
      mcpServers: {
        pager: { name: "pager", type: "sse", url: "https://mcp.example.com/pager", plugin: label },
      },
    }
  ).build();
  expect(agent.manifest).toEqual({
    manifestSchemaVersion: 7,
    id: "support",
    instructions: ["Help.", "Follow the runbook."],
    skills: {
      deploy: { name: "deploy", description: "Deploy a service.", files: { "SKILL.md": SKILL_MD }, plugin: label },
    },
    mcpServers: {
      linear: { name: "linear", type: "streamable-http", url: "https://mcp.example.com/linear" },
      pager: { name: "pager", type: "sse", url: "https://mcp.example.com/pager", plugin: label },
    },
  });
  // The Runtime pins load_skill and the catalog; the definition carries neither.
  expect(agent.manifest).not.toHaveProperty("tools");
  expect(agent.manifest).not.toHaveProperty("runtime");
  expect(JSON.stringify(agent.manifest)).not.toContain("load_skill");
  expect(JSON.stringify(agent.manifest)).not.toContain("available_skills");
  expect(agent.getBinding().tools).toEqual([]);
  expect(agent.getBinding().parts.map((part) => part.id)).toEqual(["agent", "mcp", "plugin:ops"]);
  expect(AgentManifestSchema.safeParse(agent.manifest).success).toBe(true);
  // A skill or server named twice, by two parts, fails the build.
  expect(() =>
    addPart(Agent({ id: "a" }).mcp({ pager: { type: "sse", url: "https://mcp.example.com/p" } }), {
      id: "plugin:ops",
      mcpServers: { pager: { name: "pager", type: "sse", url: "https://mcp.example.com/pager" } },
    }).build()
  ).toThrow(/Duplicate MCP server 'pager'/);
});
