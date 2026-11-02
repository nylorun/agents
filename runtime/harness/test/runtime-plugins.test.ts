/**
 * The Runtime's plugins in the harness (ADR-105): a plugin's tool keeps its effect name, so its
 * calls are dispatched and recorded as without plugins; `ask` pauses the turn with a question;
 * a declared plugin's skill is served from the bundle.
 */
import { describe, expect, it } from "vitest";
import { Agent, type AgentManifest } from "@nylorun/core/define";
import { createDurableCheckpoint, runDurable, type DurableHost } from "../src/run/index.js";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import { PLUGIN_NAMES, pluginOf, pluginTools } from "@nylorun/core/engine";
import type { HostEffect } from "../src/run/index.js";
import type { HarnessRun } from "../src/api/executors.js";
import { engineToolsFor } from "../src/tools/engine-tools.js";
import { ASK_TOOL, isAskTool, runAskTool } from "../src/tools/ask.js";
import { runSkillTool, type SkillToolContext } from "../src/tools/skills.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "../src/tools/sandbox.js";

const options = {
  artifactPageBytes: 1024,
  sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS,
  skillReadBytes: 1024,
};
const declared = PLUGIN_NAMES.map((name) => ({
  name,
  tools: pluginTools(name),
  sha256: pluginOf(name).sha256,
}));
const agent = {
  engine: { plugins: declared, artifacts: { read: true }, sandbox: ["bash" as const] },
};

const askEffect = (input: unknown, resume?: unknown) =>
  ({
    kind: "tool",
    effectId: "t1:0:tool:a0",
    toolName: ASK_TOOL,
    target: { kind: "harness" },
    input,
    context: resume === undefined ? {} : { resume },
  }) as unknown as HostEffect;

describe("a Runtime plugin's tools in the harness", () => {
  it("are named nylorun__<tool> for the model and keep their effect name", () => {
    const { tools } = engineToolsFor(
      agent,
      { sandbox: { workspace: "/workspace" } } as never,
      options,
      { access: "read_write", root: true },
      true,
      true,
      true,
      true,
    );
    const memory = tools.find((tool) => tool.name === "nylorun__memory")!;
    expect(memory).toMatchObject({
      effectName: "memory",
      target: { kind: "runtime", operation: "memory" },
    });
    expect(tools.find((tool) => tool.name === "nylorun__ask")).toMatchObject({
      effectName: "ask",
      target: { kind: "harness" },
    });
    expect(tools.find((tool) => tool.name === "nylorun__bash")).toMatchObject({
      effectName: "bash",
      target: { kind: "sandbox" },
    });
  });

  it("offer ask to the root agent only, when the version sets loop.ask", () => {
    const names = (ask: boolean) =>
      engineToolsFor(agent, undefined, options, undefined, false, true, false, ask).tools.map(
        (tool) => tool.name,
      );
    expect(names(true)).toContain("nylorun__ask");
    expect(names(false)).not.toContain("nylorun__ask");
  });
});

describe("a call of ask", () => {
  it("waits on a response interaction that says it is a question", () => {
    expect(isAskTool(askEffect({}))).toBe(true);
    expect(
      runAskTool(
        askEffect({
          question: " Which repo? ",
          choices: ["web", "bot", ""],
          why: "To open the PR.",
        }),
      ),
    ).toEqual({
      kind: "interaction-required",
      interaction: {
        kind: "response",
        prompt: "Which repo?",
        metadata: { kind: "question", choices: ["web", "bot"], why: "To open the PR." },
      },
    });
  });

  it("answers with the value once the caller responds", () => {
    expect(
      runAskTool(askEffect({ question: "Which repo?" }, { kind: "response", value: "web" })),
    ).toEqual({ kind: "completed", output: "Answer: web" });
    expect(
      runAskTool(
        askEffect({ question: "Which repo?" }, { kind: "response", value: { answer: "bot" } }),
      ),
    ).toEqual({ kind: "completed", output: "Answer: bot" });
  });

  it("refuses a call without a question", () => {
    expect(runAskTool(askEffect({ question: " " }))).toMatchObject({
      kind: "failed",
      code: "ask.invalid_input",
    });
  });
});

describe("a declared plugin's skill", () => {
  const run = {
    runId: "r1",
    start: { limits: RUNTIME_LIMIT_DEFAULTS },
    signal: new AbortController().signal,
  } as unknown as HarnessRun;
  const context = (plugins: typeof declared): SkillToolContext => ({
    channel: {
      async request() {
        throw new Error("a plugin's skill is never read from the definition files");
      },
    } as unknown as SkillToolContext["channel"],
    run,
    agent: { engine: { plugins } },
    readBytes: 1024,
    sandboxed: false,
    signal: new AbortController().signal,
  });
  const load = (name: string) =>
    ({
      effectId: "t1:0:tool:s0",
      kind: "tool",
      toolName: "load_skill",
      target: { kind: "harness" },
      input: { name },
      context: {},
    }) as unknown as HostEffect;

  it("loads from the bundle", async () => {
    const outcome = (await runSkillTool(load("memory"), context(declared))) as {
      kind: string;
      output: { name: string; content: string };
    };
    expect(outcome.kind).toBe("completed");
    expect(outcome.output.name).toBe("memory");
    expect(outcome.output.content).toContain("# Keeping memory");
  });

  it("is unknown when its plugin isn't declared", async () => {
    const outcome = await runSkillTool(
      load("memory"),
      context(declared.filter((plugin) => plugin.name !== "nylorun-memory")),
    );
    expect(outcome).toMatchObject({
      kind: "completed",
      output: { unknown: "memory", available: ["triggers"] },
    });
  });
});

describe("a plugin tool's call in a durable run", () => {
  it("is recorded under its effect name and target, as without plugins", async () => {
    const definition = Agent({ id: "keeper" }).instructions("Keep notes.").build().manifest;
    const manifest = {
      ...definition,
      engine: {
        plugins: [
          { name: "nylorun-memory", tools: ["memory"], sha256: pluginOf("nylorun-memory").sha256 },
        ],
      },
    } as unknown as AgentManifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "s",
      turnId: "t",
      input: "go",
    });
    const offered: string[][] = [];
    const tools: HostEffect[] = [];
    const host: DurableHost = {
      async resolveEffect(effect) {
        if (effect.kind === "model") {
          const call = effect.input as { tools: { name: string }[]; prompt: { kind?: string }[] };
          offered.push(call.tools.map((tool) => tool.name));
          const output =
            call.prompt.at(-1)?.kind === "tool-result"
              ? [{ type: "text", text: "done" }]
              : [
                  {
                    type: "tool-call",
                    id: "m",
                    name: "nylorun__memory",
                    args: { command: "view", path: "/memories" },
                  },
                ];
          return { status: "completed", outcome: { value: { output } } };
        }
        tools.push(effect);
        return {
          status: "completed",
          outcome: { value: { kind: "completed", output: "Here are the files." } },
        };
      },
    };
    const result = await runDurable({
      manifest,
      checkpoint,
      host,
      engineTools: (agent) =>
        engineToolsFor(agent, undefined, options, { access: "read_write", root: true }),
    });
    expect(result.status).toBe("completed");
    expect(offered[0]).toEqual(["load_skill", "nylorun__memory"]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolName: "memory",
      target: { kind: "runtime", operation: "memory" },
    });
  });
});
