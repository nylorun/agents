import { expect, it } from "vitest";
import { pluginOf } from "../src/define.js";
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
    tool: "create_issue",
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
