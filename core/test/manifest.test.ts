import { expect, it } from "vitest";
import { Agent, tool } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";
import { addPart } from "./support/parts.js";
import { z } from "zod";

const github = {
  name: "github",
  type: "streamable-http" as const,
  url: "https://mcp.example.com/github",
};

function manifest(fields: Record<string, unknown> = {}) {
  return {
    manifestSchemaVersion: 7 as const,
    id: "issue-bot",
    ...fields,
  };
}

const issues = (json: unknown) => {
  const parsed = AgentManifestSchema.safeParse(json);
  return parsed.success ? undefined : parsed.error.issues.map((item) => item.message).join("; ");
};

const plain = (name: string) => ({ name, inputSchema: { type: "object" } });

it("round-trips a flat manifest with a named streamable-http server", () => {
  const built = Agent({ id: "issue-bot", name: "Issue bot" }).build();
  expect(built.manifest).toEqual({ manifestSchemaVersion: 7, id: "issue-bot", name: "Issue bot" });
  expect(built.manifest).not.toHaveProperty("runtime");
  expect(built.manifest).not.toHaveProperty("capabilities");
  const json = manifest({
    metadata: { source: "package" },
    instructions: ["Triage issues."],
    mcpServers: { github: { ...github, plugin: { name: "issue-management", version: "1.2.0" } } },
  });
  expect(AgentManifestSchema.safeParse(json).success).toBe(true);
  const restored = Agent.from(json, {});
  expect(restored.manifest).toEqual(json);
  expect(restored.toJSON()).toEqual(restored.manifest);
});

const SKILL_MD = `sha256:${"a".repeat(64)}`;
const LABELS = `sha256:${"b".repeat(64)}`;

function skillManifest(files: unknown, extra: Record<string, unknown> = {}) {
  return manifest({
    skills: {
      triage: { name: "triage", description: "Triage an issue.", files, ...extra },
    },
  });
}

it("accepts a skill's files by hash and rejects file contents", () => {
  const skill = skillManifest({ "SKILL.md": SKILL_MD, "references/labels.md": LABELS });
  expect(AgentManifestSchema.safeParse(skill).success).toBe(true);
  const restored = Agent.from(skill, {});
  expect(restored.manifest.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue.",
    files: { "SKILL.md": SKILL_MD, "references/labels.md": LABELS },
  });
  // The Runtime pins the skill tools in `runtime`; the definition carries none.
  expect(restored.getBinding().tools).toEqual([]);

  expect(issues(skillManifest({ "SKILL.md": SKILL_MD }, { instructions: "Body" }))).toBeDefined();
  expect(
    issues(skillManifest({ "SKILL.md": SKILL_MD }, { resources: { "references/labels.md": "# Labels\n" } })),
  ).toBeDefined();
});

it("carries a plugin label on skills and servers, and refuses a malformed one", () => {
  const label = { name: "ops", version: "1.0.0" };
  const json = manifest({
    skills: { triage: { name: "triage", description: "Triage.", files: { "SKILL.md": SKILL_MD }, plugin: label } },
    mcpServers: { github: { ...github, plugin: { name: "ops" } } },
  });
  const parsed = AgentManifestSchema.safeParse(json);
  expect(parsed.success).toBe(true);
  expect(parsed.data?.skills?.triage?.plugin).toEqual(label);
  expect(parsed.data?.mcpServers?.github?.plugin).toEqual({ name: "ops" });
  expect(Agent.from(json, {}).manifest).toEqual(json);
  const withLabel = (plugin: unknown) =>
    issues(manifest({ mcpServers: { github: { ...github, plugin } } }));
  expect(withLabel({ name: "" })).toBeDefined();
  expect(withLabel({ version: "1" })).toBeDefined();
  expect(withLabel({ name: "ops", version: "" })).toBeDefined();
  expect(withLabel({ name: "ops", extra: true })).toBeDefined();
  expect(withLabel("ops")).toBeDefined();
});

it("validates a skill's file paths, hashes and count", () => {
  const issue = (files: unknown) => issues(skillManifest(files));
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
  expect(() => Agent.from(skillManifest({ "notes.md": LABELS }), {})).toThrow(
    /Skill 'triage' files must include SKILL.md/,
  );
});

it("reserves functions", () => {
  const reserved = { ...manifest(), functions: {} };
  expect(issues(reserved)).toContain("Functions are not available yet");
  expect(() => Agent.from(reserved, {})).toThrow("Functions are not available yet");
});

it("rejects a key that differs from the name, and empty maps", () => {
  const mismatched = manifest({ mcpServers: { other: github } });
  expect(issues(mismatched)).toContain("mcpServers key 'other' must equal the server name");
  expect(() => Agent.from(mismatched, {})).toThrow(HarnessError);
  expect(issues(manifest({ mcpServers: {} }))).toContain("mcpServers must be omitted");
  expect(issues(manifest({ skills: {} }))).toContain("skills must be omitted");
  expect(
    issues(manifest({ skills: { other: { name: "triage", description: "T.", files: { "SKILL.md": SKILL_MD } } } })),
  ).toContain("skills key 'other' must equal the skill name");
});

it("refuses an author tool named like a Runtime tool, or containing __", () => {
  for (const name of ["bash", "save_artifact", "read_artifact", "load_skill", "read_skill_resource", "tool_search", "tool_call"])
    expect(issues(manifest({ tools: [plain(name)] })), name).toContain(
      `Tool '${name}' takes the name of a tool the Runtime serves; rename it`,
    );
  expect(issues(manifest({ tools: [plain("github__list")] }))).toContain(
    "Tool 'github__list' must not contain '__', which names an MCP server's tools",
  );
  expect(issues(manifest({ tools: [plain("search_v2"), plain("a_b")] }))).toBeUndefined();
  // The builder refuses the same at build time.
  const named = (name: string) =>
    tool({ name, inputSchema: z.object({}), execute: async () => "ok" });
  expect(() => Agent({ id: "bot" }).tools(named("bash")).build()).toThrow(
    /Tool 'bash' takes the name of a tool the Runtime serves/,
  );
  expect(() => Agent({ id: "bot" }).tools(named("gh__list")).build()).toThrow(/must not contain '__'/);
});

it("keeps tool names unique across tools and runtime.tools, and runtime.tools to Runtime tools", () => {
  expect(issues(manifest({ tools: [plain("search"), plain("search")] }))).toContain("Tool names must be unique");
  const bash = plain("bash");
  expect(issues(manifest({ runtime: { tools: [bash] } }))).toBeUndefined();
  expect(issues(manifest({ runtime: { tools: [bash, bash] } }))).toContain("Tool names must be unique");
  expect(issues(manifest({ runtime: { tools: [plain("search")] } }))).toContain(
    "runtime.tools holds only the tools the Runtime serves, not 'search'",
  );
  expect(issues(manifest({ runtime: { extra: true } }))).toBeDefined();
});

it("refuses hooks with what replaces them", () => {
  const noop = () => ({});
  expect(() =>
    addPart(Agent({ id: "hooked" }), { id: "policy", before: { step: noop } } as never)
  ).toThrow(/hooks were removed/);
  expect(() => addPart(Agent({ id: "hooked" }), { id: "policy", model: "gpt" } as never)).toThrow(
    /Runtime owns model resolution/,
  );
  expect(issues({ ...manifest(), hooks: [{ at: "before", scope: "step" }] })).toBeDefined();
});

it("refuses manifest v6 and older, and capabilities, with a message to rebuild", () => {
  for (const version of [3, 4, 5, 6]) {
    const json = { manifestSchemaVersion: version, id: "old", capabilities: [] };
    expect(() => Agent.from(json, {})).toThrow(
      new RegExp(`manifestSchemaVersion ${version} is no longer supported: manifest v7 has no capabilities.*MIGRATION\\.md`),
    );
    expect(issues(json)).toMatch(new RegExp(`manifestSchemaVersion ${version} is no longer supported`));
  }
  expect(issues({ manifestSchemaVersion: 8, id: "new" })).toContain("Unsupported manifestSchemaVersion 8");
  expect(issues({ ...manifest(), capabilities: [] })).toContain(
    "Manifest v7 has no capabilities: the agent's instructions, tools, skills and mcpServers are top-level fields",
  );
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
  expect(refusal({ ...manifest(), model: "gpt" })).toContain(
    "Manifest must not include top-level model; Runtime owns model resolution"
  );
  const { manifestSchemaVersion: _version, ...unversioned } = manifest();
  expect(refusal({ ...unversioned, schemaVersion: 2 })).toContain(
    "Manifest field schemaVersion was renamed to manifestSchemaVersion"
  );
  // The schema's own checks, which the rebuild used to skip: unknown fields, tool names.
  expect(refusal({ ...manifest(), extra: true })).toMatch(/extra/);
  expect(refusal(manifest({ tools: [plain("open.pr")] }))).toContain("tools.0.name: Tool name 'open.pr'");
  expect(() => Agent.from({ ...manifest(), metadata: { at: new Date() } }, {})).toThrow(
    expect.objectContaining({ code: "json.invalid-data" })
  );
});

it("rebuilds a frozen copy of the manifest", () => {
  const json = { ...manifest(), metadata: { tags: ["a"] }, instructions: ["Be brief."] };
  const restored = Agent.from(json, {});
  expect(restored.manifest).toEqual(json);
  expect(Object.isFrozen(restored.manifest.metadata?.tags)).toBe(true);
  expect(Object.isFrozen(restored.manifest.instructions)).toBe(true);
  expect(Object.isFrozen(json.metadata)).toBe(false);
});

it("refuses a pinned sandbox without its tools, and a hooks field with what replaces it", () => {
  const base = { manifestSchemaVersion: 7, id: "a" };
  expect(
    AgentManifestSchema.safeParse({ ...base, runtime: { sandbox: { image: "node:24" } } }).error?.issues[0]
      ?.message
  ).toMatch(/runtime\.sandbox comes with the sandbox tools/);
  expect(AgentManifestSchema.safeParse({ ...base, hooks: {} }).error?.issues[0]?.message).toMatch(
    /hooks were removed/
  );
});
