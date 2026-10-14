import { expect, it } from "vitest";
import { pluginOf, skillOfToolCall } from "../src/define.js";
import {
  ToolCallSchema,
  ToolCompletedPayloadSchema,
} from "../src/contracts.js";

const sha = `sha256:${"a".repeat(64)}`;
const agent = {
  skills: {
    triage: {
      name: "triage",
      description: "Triage.",
      files: { "SKILL.md": sha },
      plugin: { name: "ops", version: "1.2.0" },
    },
    notes: { name: "notes", description: "Notes.", files: { "SKILL.md": sha } },
  },
  mcpServers: {
    linear: {
      name: "linear",
      type: "streamable-http" as const,
      url: "https://mcp.linear.app/mcp",
      plugin: { name: "ops" },
    },
    docs: {
      name: "docs",
      type: "sse" as const,
      url: "https://docs.example.com/sse",
    },
  },
};

it("names the skill a skill tool loads, by its input", () => {
  expect(skillOfToolCall(agent, "load_skill", { name: "triage" })).toBe(
    "triage",
  );
  expect(
    skillOfToolCall(agent, "read_skill_resource", {
      name: "notes",
      path: "a.md",
    }),
  ).toBe("notes");
  expect(
    skillOfToolCall(agent, "load_skill", { name: "missing" }),
  ).toBeUndefined();
});

it("matches a sandbox tool's input on the skills' mount path", () => {
  expect(
    skillOfToolCall(agent, "bash", {
      command: "python /skills/triage/scripts/run.py --x",
    }),
  ).toBe("triage");
  expect(
    skillOfToolCall(agent, "read", { path: "/skills/notes/references/a.md" }),
  ).toBe("notes");
  expect(
    skillOfToolCall(agent, "grep", {
      pattern: "todo",
      path: "/skills/triage/",
    }),
  ).toBe("triage");
  // A script started without its path in the command is not traced.
  expect(
    skillOfToolCall(agent, "bash", { command: "cd /skills && ./run" }),
  ).toBeUndefined();
  expect(
    skillOfToolCall(agent, "bash", { command: "cat /skills/other/x" }),
  ).toBeUndefined();
  // Only sandbox and skill tools are traced to a skill.
  expect(
    skillOfToolCall(agent, "lookup", { path: "/skills/triage/a" }),
  ).toBeUndefined();
  expect(
    skillOfToolCall({}, "bash", { command: "/skills/triage/run" }),
  ).toBeUndefined();
});

it("names the plugin that brought a skill or a server", () => {
  expect(pluginOf(agent, { skill: "triage" })).toEqual({
    name: "ops",
    version: "1.2.0",
  });
  expect(pluginOf(agent, { skill: "notes" })).toBeUndefined();
  expect(pluginOf(agent, { server: "linear" })).toEqual({ name: "ops" });
  expect(pluginOf(agent, { server: "docs" })).toBeUndefined();
});

it("carries skill, plugin and the harness kind on tool.completed and tool-call rows", () => {
  const completed = {
    callId: "c1",
    invocationId: "i1",
    toolName: "bash",
    kind: "sandbox",
    skill: "triage",
    plugin: { name: "ops", version: "1.2.0" },
  };
  expect(ToolCompletedPayloadSchema.safeParse(completed).success).toBe(true);
  expect(
    ToolCompletedPayloadSchema.safeParse({
      callId: "c2",
      invocationId: "i2",
      toolName: "fetch_page",
      kind: "harness",
    }).success,
  ).toBe(true);
  const row = {
    effectId: "e1",
    turnId: "t1",
    callId: "c1",
    toolName: "linear__create_issue",
    kind: "mcp",
    server: "linear",
    skill: null,
    plugin: { name: "ops" },
    status: "completed",
    attempts: 1,
    input: {},
    error: null,
    startedAt: null,
    settledAt: null,
    durationMs: null,
  };
  expect(ToolCallSchema.safeParse(row).success).toBe(true);
});
