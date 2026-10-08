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

const SKILL_MD = `sha256:${"a".repeat(64)}`;
const LABELS = `sha256:${"b".repeat(64)}`;

function skillManifest(files: unknown, extra: Record<string, unknown> = {}) {
  return manifest([
    {
      id: "docs",
      type: "agent-plugin",
      skills: {
        triage: { name: "triage", description: "Triage an issue.", files, ...extra },
      },
    },
  ]);
}

it("accepts a skill's files by hash and rejects file contents", () => {
  const skill = skillManifest({ "SKILL.md": SKILL_MD, "references/labels.md": LABELS });
  expect(AgentManifestSchema.safeParse(skill).success).toBe(true);
  const restored = Agent.from(skill, { docs: {} });
  expect(restored.manifest.capabilities[0]?.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue.",
    files: { "SKILL.md": SKILL_MD, "references/labels.md": LABELS },
  });
  // The Runtime serves the skill tools; the build attaches them from the manifest's skills.
  expect(restored.getBinding().tools.map((tool) => tool.name)).toEqual([
    "load_skill",
    "read_skill_resource",
  ]);

  expect(
    AgentManifestSchema.safeParse(skillManifest({ "SKILL.md": SKILL_MD }, { instructions: "Body" }))
      .success,
  ).toBe(false);
  expect(
    AgentManifestSchema.safeParse(
      skillManifest({ "SKILL.md": SKILL_MD }, { resources: { "references/labels.md": "# Labels\n" } }),
    ).success,
  ).toBe(false);
});

it("validates a skill's file paths, hashes and count", () => {
  const issue = (files: unknown) => {
    const parsed = AgentManifestSchema.safeParse(skillManifest(files));
    return parsed.success ? undefined : parsed.error.issues.map((item) => item.message).join("; ");
  };
  expect(issue({ "SKILL.md": SKILL_MD, "scripts/run.py": LABELS, "assets/logo.png": LABELS })).toBeUndefined();
  expect(issue({ "notes.md": LABELS })).toContain("files must include SKILL.md");
  expect(issue(undefined)).toBeDefined();
  for (const path of ["../escape.md", "/etc/passwd", "a\\b.md", "a//b.md", "./a.md", "a/../b.md", "x".repeat(513)])
    expect(issue({ "SKILL.md": SKILL_MD, [path]: LABELS }), path).toContain("file path");
  expect(issue({ "SKILL.md": "sha256:ABC" })).toContain("sha256:<64 lowercase hex>");
  expect(issue({ "SKILL.md": "a".repeat(64) })).toContain("sha256:<64 lowercase hex>");
  const many: Record<string, string> = { "SKILL.md": SKILL_MD };
  for (let index = 0; index < 500; index += 1) many[`f${index}.txt`] = LABELS;
  expect(issue(many)).toContain("a skill may have at most 500");
  expect(() => Agent.from(skillManifest({ "notes.md": LABELS }), { docs: {} })).toThrow(
    /Skill 'triage' files must include SKILL.md/,
  );
});

it("reserves functions", () => {
  const reserved = { ...manifest([]), functions: {} };
  const parsed = AgentManifestSchema.safeParse(reserved);
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues.map((item) => item.message)).toContain("Functions are not available yet");
  expect(() => Agent.from(reserved, {})).toThrow("Functions are not available yet");
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

it("rebuilds only what AgentManifestSchema accepts, refusing with its messages", () => {
  const refusal = (json: Record<string, unknown>) => {
    const parsed = AgentManifestSchema.safeParse(json);
    expect(parsed.success).toBe(false);
    try {
      Agent.from(json, {});
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe("agent.build-failed");
      for (const issue of parsed.error!.issues)
        expect((error as HarnessError).message).toContain(issue.message);
      return (error as HarnessError).message;
    }
    throw new Error("Agent.from accepted the manifest");
  };
  expect(refusal({ ...manifest([]), model: "gpt" })).toContain(
    "Manifest must not include top-level model; Runtime owns model resolution"
  );
  const { manifestSchemaVersion: _version, ...unversioned } = manifest([]);
  expect(refusal({ ...unversioned, schemaVersion: 2 })).toContain(
    "Manifest field schemaVersion was renamed to manifestSchemaVersion"
  );
  expect(refusal(manifest([{ id: "chat", type: "agent", model: "gpt" }]))).toContain(
    "A capability must not include model"
  );
  // The schema's own checks, which the rebuild used to skip: unknown fields, tool names.
  expect(refusal({ ...manifest([]), extra: true })).toMatch(/extra/);
  expect(
    refusal(
      manifest([
        { id: "tools", type: "agent", tools: [{ name: "open.pr", inputSchema: { type: "object" } }] },
      ])
    )
  ).toContain("capabilities.0.tools.0.name: Tool name 'open.pr'");
  expect(() => Agent.from({ ...manifest([]), metadata: { at: new Date() } }, {})).toThrow(
    expect.objectContaining({ code: "json.invalid-data" })
  );
});

it("rebuilds a frozen copy of the manifest", () => {
  const json = manifest([{ id: "docs", type: "agent", metadata: { tags: ["a"] } }]);
  const restored = Agent.from(json, { docs: {} });
  expect(restored.manifest).toEqual(json);
  expect(Object.isFrozen(restored.manifest.capabilities[0]?.metadata?.tags)).toBe(true);
  expect(Object.isFrozen(json.capabilities[0])).toBe(false);
});
