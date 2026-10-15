import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type AgentManifest, type ModelConfigurationSnapshot } from "@nylorun/core/define";
import { createDurableCheckpoint, runDurable, type DurableHost } from "../src/run/index.js";
import { engineToolsFor } from "../src/tools/engine-tools.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "../src/tools/sandbox.js";
import { testAgent, model, tool, toolCalls, turn } from "./fixtures.js";

/**
 * The first model call of an agent with skills, with and without a sandbox, as the Runtime's
 * `runtime` block made it before protocol 15 moved the text and tools into our engine. The bytes
 * must not change: they are the prompt cache's prefix.
 */
const BEFORE = JSON.parse(
  readFileSync(new URL("./fixtures/engine-prompt.json", import.meta.url), "utf8"),
) as Record<"sandbox" | "bare", unknown>;

const h = (c: string) => "sha256:" + c.repeat(64);
const skills = {
  pdf: {
    name: "pdf",
    description: 'Work with PDF <files> & "forms".',
    files: { "SKILL.md": h("a"), "scripts/fill.py": h("b") },
  },
  notes: { name: "notes", description: "Take notes.", files: { "SKILL.md": h("c") } },
};

async function firstCall(sandboxed: boolean): Promise<unknown> {
  const base = Agent({ id: "coder" })
    .instructions("Fix the tests.")
    .tools({ name: "job", inputSchema: z.object({}), execute: async () => "unused" })
    .build().manifest;
  const manifest = { ...base, skills } as AgentManifest;
  const checkpoint = createDurableCheckpoint({
    manifest,
    sessionId: "s",
    turnId: "t",
    input: "go",
  });
  let first: unknown;
  const host: DurableHost = {
    async resolveEffect(effect) {
      first ??= effect.input;
      return {
        status: "completed",
        outcome: { value: { output: [{ type: "text", text: "done" }] } },
      };
    },
  };
  const environment = {
    id: "env",
    kind: sandboxed ? ("virtual" as const) : ("none" as const),
    ...(sandboxed ? { sandbox: { workspace: "/workspace" } } : {}),
  };
  await runDurable({
    manifest,
    checkpoint,
    host,
    engineTools: (agent) =>
      engineToolsFor(agent, environment, {
        artifactPageBytes: 32768,
        sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS,
        skillReadBytes: 1024,
      }),
    sessionTools: [
      { name: "github__get_issue", inputSchema: { type: "object" }, target: { kind: "mcp" } },
      {
        name: "tool_search",
        description: "Search.",
        inputSchema: { type: "object" },
        instructions: ["MCP note."],
        target: { kind: "platform" },
      },
    ],
  });
  return first;
}

describe("our engine's text and tools (protocol 15)", () => {
  it.each(["sandbox", "bare"] as const)(
    "keeps the prompt prefix the Runtime's runtime block made (%s)",
    async (kind) => {
      expect(await firstCall(kind === "sandbox")).toEqual(BEFORE[kind]);
      expect(JSON.stringify(await firstCall(kind === "sandbox"))).toBe(
        JSON.stringify(BEFORE[kind]),
      );
    },
  );
});

describe("model configuration", () => {
  it("offers each part's instructions and tools on every model step", async () => {
    const snapshots: ModelConfigurationSnapshot[] = [];
    let calls = 0;
    const agent = testAgent()
      .instructions("Policy")
      .tools(tool())
      .with(
        model(async (_call, { request }) => {
          snapshots.push(request.configuration);
          return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();

    await turn(agent).handle.completed;

    expect(snapshots.map((snapshot) => snapshot.instructions.map((item) => item.text))).toEqual([
      ["Policy"],
      ["Policy"],
    ]);
    expect(snapshots.map((snapshot) => snapshot.tools.map((tool) => tool.name))).toEqual([
      ["echo"],
      ["echo"],
    ]);
  });

  it("orders parts as they were added and attributes them", async () => {
    let configuration!: ModelConfigurationSnapshot;
    const agent = testAgent()
      .part({ id: "first", instructions: ["first"], tools: [tool("first")] })
      .part({ id: "later", instructions: ["second"], tools: [tool("late")] })
      .with(
        model(async (_call, { request }) => {
          configuration = request.configuration;
          return "done";
        }),
      )
      .build();
    await turn(agent).handle.completed;

    expect(configuration.instructions.map((item) => item.text)).toEqual(["first", "second"]);
    expect(configuration.tools.map((item) => item.name)).toEqual(["first", "late"]);
    expect(configuration.contributors.map((item) => `${item.partId}:${item.slot}`)).toEqual([
      "first:first",
      "later:later",
      "first:first",
      "later:later",
    ]);
  });
});
