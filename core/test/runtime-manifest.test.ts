import { expect, it } from "vitest";
import { AgentManifestSchema, MessageEventBodySchema } from "../src/contracts.js";
import {
  Agent,
  READ_ARTIFACT_MAX_BYTES,
  READ_ARTIFACT_TOOL,
  RUNTIME_TOOL_NAMES,
  SAVE_ARTIFACT_TOOL,
  SANDBOX_INSTRUCTIONS,
  SANDBOX_TOOL_NAMES,
  SKILLS_USAGE,
  formatSkillCatalog,
  isRuntimeToolName,
  isSkillTool,
  runtimeManifestFor,
  runtimeToolOf,
  type AgentManifest,
} from "../src/define.js";

const spec = { network: { preset: "none" as const, allow: ["api.github.com"] }, idle: "15m" };
const SKILL_MD = `sha256:${"a".repeat(64)}`;
const skills = {
  triage: { name: "triage", description: "Triage an issue.", files: { "SKILL.md": SKILL_MD } },
  release: {
    name: "release",
    description: "Cut a release.",
    files: { "SKILL.md": SKILL_MD, "scripts/cut.sh": SKILL_MD },
    plugin: { name: "ops", version: "1.0.0" },
  },
};

/** A session's pinned manifest: the definition plus the `runtime` block. */
function pinned(definition: Record<string, unknown>, runtime: unknown): AgentManifest {
  return {
    manifestSchemaVersion: 7,
    id: "bot",
    ...definition,
    ...(runtime === undefined ? {} : { runtime }),
  } as AgentManifest;
}

it("adds nothing when the session has no sandbox, no artifacts and the agent no skills", () => {
  expect(runtimeManifestFor({})).toBeUndefined();
  expect(runtimeManifestFor({}, { save: false, read: false })).toBeUndefined();
});

it("pins the sandbox, its tools and instructions, then save_artifact", () => {
  const runtime = runtimeManifestFor({}, { sandbox: spec })!;
  expect(runtime.sandbox).toEqual(spec);
  expect(runtime.tools?.map((tool) => tool.name)).toEqual([...SANDBOX_TOOL_NAMES, SAVE_ARTIFACT_TOOL]);
  expect(runtime.instructions?.[0]).toBe(SANDBOX_INSTRUCTIONS);
  expect(runtime.instructions?.[1]).toContain("save_artifact");
  expect(runtime.instructions).toHaveLength(2);
  expect(runtime.tools?.every((tool) => tool.description && tool.inputSchema)).toBe(true);
  const save = runtimeToolOf(pinned({}, runtime), SAVE_ARTIFACT_TOOL)!;
  expect(Object.keys(save.inputSchema.properties as object)).toEqual([
    "path",
    "content",
    "name",
    "contentType",
    "artifactId",
  ]);
  expect(AgentManifestSchema.safeParse(pinned({}, runtime)).success).toBe(true);
  // The workspace path the backend uses is named in the tools' text.
  const elsewhere = runtimeManifestFor({}, { sandbox: {}, workspace: "/home/agent" })!;
  expect(elsewhere.instructions?.[0]).toContain("/home/agent");
  expect(elsewhere.instructions?.[0]).not.toContain("/workspace");
  // save_artifact may be left out.
  expect(runtimeManifestFor({}, { sandbox: {}, save: false })!.tools?.map((tool) => tool.name)).toEqual([
    ...SANDBOX_TOOL_NAMES,
  ]);
});

it("pins read_artifact, with or without save_artifact (R2b C11)", () => {
  const read = runtimeManifestFor({}, { read: true })!;
  expect(read.sandbox).toBeUndefined();
  expect(read.tools?.map((tool) => tool.name)).toEqual([READ_ARTIFACT_TOOL]);
  expect(read.tools![0]!.inputSchema).toMatchObject({
    required: ["artifactId"],
    properties: {
      version: { minimum: 1 },
      offset: { minimum: 0 },
      length: { maximum: READ_ARTIFACT_MAX_BYTES },
    },
  });
  expect(read.instructions?.join(" ")).toContain("read_artifact");
  // A file of an earlier turn is a reference line the model reads again (protocol 12).
  expect(read.instructions?.join(" ")).toContain("[Uploaded artifact");
  expect(read.instructions?.join(" ")).not.toContain("save_artifact");
  const both = runtimeManifestFor({}, { save: true, read: true })!;
  expect(both.tools?.map((tool) => tool.name)).toEqual([SAVE_ARTIFACT_TOOL, READ_ARTIFACT_TOOL]);
  expect(AgentManifestSchema.safeParse(pinned({}, read)).success).toBe(true);
});

it("pins the skill tools and the catalog when the agent has skills", () => {
  const runtime = runtimeManifestFor({ skills })!;
  expect(runtime.sandbox).toBeUndefined();
  expect(runtime.tools?.map((tool) => tool.name)).toEqual(["load_skill", "read_skill_resource"]);
  expect(runtime.instructions).toEqual([
    SKILLS_USAGE,
    formatSkillCatalog([
      { name: "triage", description: "Triage an issue." },
      { name: "release", description: "Cut a release." },
    ]),
  ]);
  expect(runtime.instructions?.[1]).toContain("<name>triage</name>");
  const manifest = pinned({ skills }, runtime);
  expect(AgentManifestSchema.safeParse(manifest).success).toBe(true);
  expect(isSkillTool(manifest, "load_skill")).toBe(true);
  expect(isSkillTool(manifest, "read_skill_resource")).toBe(true);
  expect(isSkillTool(manifest, "bash")).toBe(false);
  // read_skill_resource only when a skill has files besides SKILL.md.
  expect(runtimeManifestFor({ skills: { triage: skills.triage } })!.tools?.map((tool) => tool.name)).toEqual([
    "load_skill",
  ]);
  // A skill tool counts only where the Runtime pinned it.
  expect(isSkillTool(pinned({ skills }, undefined), "load_skill")).toBe(false);
});

it("orders tools sandbox, artifacts, skills; and text skills, sandbox with mounts, artifacts", () => {
  const runtime = runtimeManifestFor({ skills }, { sandbox: spec, read: true })!;
  expect(runtime.tools?.map((tool) => tool.name)).toEqual([
    ...SANDBOX_TOOL_NAMES,
    SAVE_ARTIFACT_TOOL,
    READ_ARTIFACT_TOOL,
    "load_skill",
    "read_skill_resource",
  ]);
  const text = runtime.instructions!;
  expect(text[0]).toBe(SKILLS_USAGE);
  expect(text[1]).toContain("<available_skills>");
  expect(text[2]).toBe(SANDBOX_INSTRUCTIONS);
  expect(text[3]).toContain("/skills/triage/");
  expect(text[3]).toContain("/skills/release/");
  expect(text[4]).toContain("save_artifact");
  expect(text[5]).toContain("read_artifact");
  expect(text).toHaveLength(6);
  // Without skills, the sandbox names no mounts.
  expect(runtimeManifestFor({}, { sandbox: spec })!.instructions?.join(" ")).not.toContain("/skills/");
  const manifest = pinned({ skills }, runtime);
  expect(AgentManifestSchema.safeParse(manifest).success).toBe(true);
  // The pinned manifest rebuilds; the Runtime's tools run only in the Runtime.
  const agent = Agent.from(manifest, {});
  expect(agent.manifest.runtime).toEqual(runtime);
  expect(agent.getBinding().tools.map((tool) => tool.name)).toEqual(runtime.tools!.map((tool) => tool.name));
});

it("names every Runtime tool, and runtimeToolOf finds one only in runtime", () => {
  for (const name of [
    ...SANDBOX_TOOL_NAMES,
    SAVE_ARTIFACT_TOOL,
    READ_ARTIFACT_TOOL,
    "load_skill",
    "read_skill_resource",
    "tool_search",
    "tool_call",
  ])
    expect(isRuntimeToolName(name), name).toBe(true);
  expect(RUNTIME_TOOL_NAMES.size).toBe(SANDBOX_TOOL_NAMES.length + 6);
  expect(isRuntimeToolName("search")).toBe(false);
  const manifest = pinned({}, runtimeManifestFor({}, { sandbox: {} }));
  expect(runtimeToolOf(manifest, "bash")?.name).toBe("bash");
  expect(runtimeToolOf(manifest, "search")).toBeUndefined();
  expect(runtimeToolOf(manifest, undefined)).toBeUndefined();
  expect(runtimeToolOf(undefined, "bash")).toBeUndefined();
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
