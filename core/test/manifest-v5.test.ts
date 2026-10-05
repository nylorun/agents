import { expect, it } from "vitest";
import { Agent } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";
import { hashManifest } from "../src/utils/hash.js";

const github = {
  name: "github",
  type: "streamable-http" as const,
  url: "https://mcp.example.com/github",
};

function manifest(capabilities: readonly Record<string, unknown>[]) {
  return {
    manifestSchemaVersion: 5 as const,
    id: "issue-bot",
    capabilities,
  };
}

it("round-trips a v5 capability and a named streamable-http server", () => {
  const built = Agent({ id: "issue-bot", name: "Issue bot" }).build();
  expect(built.manifest.manifestSchemaVersion).toBe(5);
  expect(built.manifest).not.toHaveProperty("runtime");
  const json = manifest([
    {
      id: "issue-management",
      type: "agent-plugin",
      metadata: { source: "package" },
      mcpServers: { github },
    },
  ]);
  expect(AgentManifestSchema.safeParse(json).success).toBe(true);
  const restored = Agent.from(json, { "issue-management": {} });
  expect(restored.manifest.capabilities[0]).toMatchObject({
    id: "issue-management",
    type: "agent-plugin",
    metadata: { source: "package" },
    mcpServers: { github },
  });
  expect(restored.toJSON()).toEqual(restored.manifest);
});

it("accepts a skill name and description and rejects file contents", () => {
  const skill = manifest([
    {
      id: "docs",
      type: "agent-plugin",
      skills: {
        triage: {
          name: "triage",
          description: "Triage an issue.",
        },
      },
    },
  ]);
  expect(AgentManifestSchema.safeParse(skill).success).toBe(true);
  const restored = Agent.from(skill, { docs: {} });
  expect(restored.manifest.capabilities[0]?.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue.",
  });
  expect(
    restored.getBinding().tools.some((tool) => tool.name === "load_skill")
  ).toBe(false);

  const withBody = manifest([
    {
      id: "docs",
      type: "agent-plugin",
      skills: {
        triage: {
          name: "triage",
          description: "Triage an issue.",
          instructions: "Body",
        },
      },
    },
  ]);
  expect(AgentManifestSchema.safeParse(withBody).success).toBe(false);

  const withResources = manifest([
    {
      id: "docs",
      type: "agent-plugin",
      skills: {
        triage: {
          name: "triage",
          description: "Triage an issue.",
          resources: { "references/labels.md": "# Labels\n" },
        },
      },
    },
  ]);
  expect(AgentManifestSchema.safeParse(withResources).success).toBe(false);
});

it("rejects a server key that differs from name and a duplicate server", () => {
  const mismatched = manifest([
    {
      id: "issue-management",
      type: "agent",
      mcpServers: { other: github },
    },
  ]);
  expect(AgentManifestSchema.safeParse(mismatched).success).toBe(false);
  expect(() => Agent.from(mismatched, { "issue-management": {} })).toThrow(
    HarnessError,
  );

  const duplicated = manifest([
    {
      id: "one",
      type: "agent",
      mcpServers: { github },
    },
    {
      id: "two",
      type: "agent",
      mcpServers: { github },
    },
  ]);
  expect(AgentManifestSchema.safeParse(duplicated).success).toBe(false);
  expect(() =>
    Agent.from(duplicated, { one: {}, two: {} }),
  ).toThrow(HarnessError);
});

it("refuses hooks with what replaces them", () => {
  const json = manifest([
    { id: "policy", type: "agent", hooks: [{ at: "before", scope: "step" }] },
  ]);
  const parsed = AgentManifestSchema.safeParse(json);
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues[0]?.message).toMatch(/hooks were removed.*HTTP tool/);
  expect(() => Agent.from(json, {})).toThrow(/hooks were removed/);
  expect(() =>
    Agent.from(manifest([{ id: "old", type: "agent", beforeModelCall: true }]), {})
  ).toThrow(/removed with hooks/);
  const noop = () => ({});
  expect(() =>
    Agent({ id: "hooked" }).use({ id: "policy", before: { step: noop } } as never)
  ).toThrow(/hooks were removed/);
});

it("refuses manifest v4 and older with a message naming the change", () => {
  for (const version of [3, 4]) {
    const json = { manifestSchemaVersion: version, id: "old", capabilities: [] };
    expect(() => Agent.from(json, {})).toThrow(/manifest v5 removed hooks.*MIGRATION\.md/);
    expect(AgentManifestSchema.safeParse(json).error?.issues[0]?.message).toMatch(
      /manifestSchemaVersion \d is no longer supported/
    );
  }
});
