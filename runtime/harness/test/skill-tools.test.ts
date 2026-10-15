/**
 * Our engine's skill tools (protocol 15): `load_skill` and `read_skill_resource` run in the
 * harness and read a skill's files over `definition.file`, a range of at most the run's
 * `limits.chunkBytes` at a time, and never more than the harness reads into the model's context
 * or one record entry holds.
 */
import { describe, expect, it } from "vitest";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/harness-api";
import type { SkillManifest } from "@nylorun/core/define";
import {
  formatSkillCatalog,
  runSkillTool,
  skillCatalogText,
  skillFolderNote,
  skillTools,
  type SkillToolContext,
} from "../src/tools/skills.js";
import type { HarnessRun } from "../src/api/executors.js";
import type { HostEffect } from "../src/run/durable.js";

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const triage: SkillManifest = {
  name: "triage",
  description: "Triage an issue.",
  files: {
    "SKILL.md": hash("a"),
    "notes.md": hash("b"),
    "logo.png": hash("c"),
    "big.txt": hash("d"),
  },
};
const bytes: Record<string, Uint8Array> = {
  [hash("a")]: new TextEncoder().encode("---\nname: triage\n---\n\nRead the issue first."),
  [hash("b")]: new TextEncoder().encode("Severity levels: 1 to 4."),
  [hash("c")]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]),
  [hash("d")]: new TextEncoder().encode("x".repeat(100)),
};

/** A core that serves `definition.file` ranges, and counts the requests. */
function core() {
  const ranges: { sha256: string; offset: number; length: number }[] = [];
  return {
    ranges,
    channel: {
      async request(method: string, params: { sha256: string; offset: number; length: number }) {
        expect(method).toBe("definition.file");
        ranges.push({ sha256: params.sha256, offset: params.offset, length: params.length });
        const all = bytes[params.sha256]!;
        const chunk = all.subarray(params.offset, params.offset + params.length);
        return { base64: Buffer.from(chunk).toString("base64") };
      },
    } as unknown as SkillToolContext["channel"],
  };
}

const run = (limits: Partial<typeof RUNTIME_LIMIT_DEFAULTS> = {}): HarnessRun =>
  ({
    runId: "r1",
    grant: { runId: "r1", sessionId: "s1", turnId: "t1", epoch: 1 },
    start: { limits: { ...RUNTIME_LIMIT_DEFAULTS, ...limits } },
    signal: new AbortController().signal,
  }) as unknown as HarnessRun;

const call = (toolName: string, input: unknown): HostEffect => ({
  effectId: "t1:0:tool:c1",
  sessionId: "s1",
  turnId: "t1",
  agentId: "bot",
  manifestHash: "h",
  kind: "tool",
  toolName,
  target: { kind: "harness" },
  input,
  context: {},
});

const context = (
  channel: SkillToolContext["channel"],
  options: {
    sandboxed?: boolean;
    readBytes?: number;
    limits?: Partial<typeof RUNTIME_LIMIT_DEFAULTS>;
  } = {},
): SkillToolContext => ({
  channel,
  run: run(options.limits),
  agent: { skills: { triage } },
  readBytes: options.readBytes ?? 1024,
  sandboxed: options.sandboxed ?? false,
  signal: new AbortController().signal,
});

describe("load_skill", () => {
  it("answers the instructions after the frontmatter, the resources, and the sandbox folder", async () => {
    const { channel } = core();
    expect(await runSkillTool(call("load_skill", { name: "triage" }), context(channel))).toEqual({
      kind: "completed",
      output: {
        name: "triage",
        content: "Read the issue first.",
        resources: ["big.txt", "logo.png", "notes.md"],
      },
    });
    const sandboxed = await runSkillTool(
      call("load_skill", { name: "triage" }),
      context(channel, { sandboxed: true }),
    );
    expect(sandboxed).toMatchObject({
      output: { sandboxPath: expect.stringMatching(/^\/skills\/triage@[0-9a-f]{12}\/$/) },
    });
  });

  it("lists the skills there are for a name there is not", async () => {
    const { channel } = core();
    expect(await runSkillTool(call("load_skill", { name: "nope" }), context(channel))).toEqual({
      kind: "completed",
      output: { unknown: "nope", available: ["triage"] },
    });
  });
});

describe("read_skill_resource", () => {
  it("reads a file in ranges of the run's chunkBytes", async () => {
    const { channel, ranges } = core();
    const outcome = await runSkillTool(
      call("read_skill_resource", { name: "triage", path: "notes.md" }),
      context(channel, { limits: { chunkBytes: 10 } }),
    );
    expect(outcome).toEqual({
      kind: "completed",
      output: { name: "triage", path: "notes.md", content: "Severity levels: 1 to 4." },
    });
    expect(ranges.map((range) => [range.offset, range.length])).toEqual([
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
  });

  it("refuses a file past the harness's skillReadBytes, reading no further than one byte past it", async () => {
    const { channel, ranges } = core();
    const outcome = await runSkillTool(
      call("read_skill_resource", { name: "triage", path: "big.txt" }),
      context(channel, { readBytes: 20, sandboxed: true, limits: { chunkBytes: 16 } }),
    );
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "skill.resource_too_large",
      message: expect.stringContaining("It is in the sandbox at /skills/triage@"),
    });
    expect(ranges).toHaveLength(2);
  });

  it("is held to the run's recordEntryBytes, below the harness's skillReadBytes", async () => {
    const { channel } = core();
    const outcome = await runSkillTool(
      call("read_skill_resource", { name: "triage", path: "big.txt" }),
      context(channel, { readBytes: 1024, limits: { recordEntryBytes: 120 } }),
    );
    // 100 bytes fit the read, but the answer's JSON does not fit one record entry.
    expect(outcome).toMatchObject({ kind: "failed", code: "skill.resource_too_large" });
    expect(outcome).toMatchObject({ message: expect.stringContaining("without a sandbox") });
  });

  it("refuses a binary file, an unknown resource and an unknown skill", async () => {
    const { channel } = core();
    expect(
      await runSkillTool(
        call("read_skill_resource", { name: "triage", path: "logo.png" }),
        context(channel),
      ),
    ).toMatchObject({ kind: "failed", code: "skill.binary_resource" });
    expect(
      await runSkillTool(
        call("read_skill_resource", { name: "triage", path: "x.md" }),
        context(channel),
      ),
    ).toMatchObject({ kind: "failed", code: "skill.unknown_resource" });
    expect(
      await runSkillTool(
        call("read_skill_resource", { name: "nope", path: "x.md" }),
        context(channel),
      ),
    ).toMatchObject({ kind: "failed", code: "skill.unknown" });
  });
});

describe("the skill text and tools", () => {
  const notes: SkillManifest = {
    name: "notes",
    description: "Take <notes>.",
    files: { "SKILL.md": hash("e") },
  };

  it("writes the catalog and the folder note", () => {
    expect(skillCatalogText([triage, notes])).toEqual([
      "The following skills provide specialized instructions. When a task matches a skill description, call load_skill with that name before proceeding.",
      formatSkillCatalog([triage, notes]),
    ]);
    expect(formatSkillCatalog([notes])).toBe(
      "<available_skills>\n  <skill>\n    <name>notes</name>\n    <description>Take &lt;notes&gt;.</description>\n  </skill>\n</available_skills>",
    );
    expect(skillFolderNote([notes])).toMatch(
      /^Each skill's files are in the sandbox, read-only, in its own folder under \/skills\/ \(notes: \/skills\/notes@[0-9a-f]{12}\/\): read them there and run their scripts with bash\.$/,
    );
  });

  it("offers load_skill, and read_skill_resource only when a skill has resources, run here", () => {
    expect(skillTools([])).toEqual([]);
    const one = skillTools([notes]);
    expect(one.map((tool) => tool.name)).toEqual(["load_skill"]);
    expect(one[0]!.inputSchema.properties).toEqual({ name: { type: "string", const: "notes" } });
    expect(one[0]!.target).toEqual({ kind: "harness" });
    const both = skillTools([triage, notes]);
    expect(both.map((tool) => tool.name)).toEqual(["load_skill", "read_skill_resource"]);
    expect((both[1]!.inputSchema.properties as { name: unknown }).name).toEqual({
      type: "string",
      enum: ["notes", "triage"],
    });
  });
});
