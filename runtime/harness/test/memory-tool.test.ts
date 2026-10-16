/**
 * `memory` (track T5, D72) in our engine: offered with Anthropic's schema when the session's
 * version sets `harness.memory`, view-only for a `read_only` agent and an agent used as a tool;
 * a `runtime` effect, operation `memory`; each command's parameters checked before the call is
 * sent; `memory.<command>` taken as the tool (E-P1); and the index pinned after the instructions.
 */
import { describe, expect, it } from "vitest";
import { Agent, type AgentManifest } from "@nylorun/core/define";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableHost,
  type HostEffect,
} from "../src/run/index.js";
import { engineToolsFor } from "../src/tools/engine-tools.js";
import { memoryIndexBlock } from "../src/tools/memory.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "../src/tools/sandbox.js";

const options = {
  artifactPageBytes: 1024,
  sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS,
  skillReadBytes: 1024,
};
const readWrite = {
  access: "read_write" as const,
  instructions: "Keep release conventions.",
  root: true,
};

type Prompt = { kind: string; role?: string; content?: { text?: string }[] }[];

/** Runs one turn whose model makes `calls` in its first step, then answers "done". */
async function turn(
  calls: { name: string; args: Record<string, unknown> }[],
  pinned: readonly string[] | undefined,
  state?: unknown,
) {
  const manifest = Agent({ id: "bot" }).instructions("Help the team.").build()
    .manifest as AgentManifest;
  const checkpoint = createDurableCheckpoint({
    manifest,
    sessionId: "s",
    turnId: state ? "t2" : "t1",
    input: "go",
    ...(state ? { state: state as never } : {}),
  });
  const prompts: Prompt[] = [];
  const tools: string[][] = [];
  const effects: HostEffect[] = [];
  const host: DurableHost = {
    async resolveEffect(effect) {
      if (effect.kind === "model") {
        const call = effect.input as { prompt: Prompt; tools: { name: string }[] };
        prompts.push(call.prompt);
        tools.push(call.tools.map((tool) => tool.name));
        const output =
          prompts.length === 1 && calls.length > 0
            ? calls.map((call, n) => ({ type: "tool-call", id: `c${n}`, ...call }))
            : [{ type: "text", text: "done" }];
        return { status: "completed", outcome: { value: { output } } };
      }
      effects.push(effect);
      return { status: "completed", outcome: { value: { kind: "completed", output: "ok" } } };
    },
  };
  const result = await runDurable({
    manifest,
    checkpoint,
    host,
    engineTools: (agent) => engineToolsFor(agent, undefined, options, readWrite),
    ...(pinned ? { pinned } : {}),
  });
  expect(result.status).toBe("completed");
  return {
    result: result as { result: { state: { pinned?: string[] } } },
    prompts,
    tools,
    effects,
  };
}

const texts = (prompt: Prompt) =>
  prompt.map((item) => item.content?.map((part) => part.text ?? "").join("") ?? "");

describe("the memory tool", () => {
  it("is offered with Anthropic's schema and our rules, then the agent's memory instructions", () => {
    const { tools, instructions } = engineToolsFor({}, undefined, options, readWrite);
    const memory = tools.find((tool) => tool.name === "memory")!;
    expect(memory.target).toEqual({ kind: "runtime", operation: "memory" });
    expect((memory.inputSchema.properties as any).command.enum).toEqual([
      "view",
      "create",
      "str_replace",
      "insert",
      "delete",
      "rename",
    ]);
    expect(memory.inputSchema.required).toEqual(["command"]);
    const text = instructions.join("\n\n");
    expect(text).toContain("You have a persistent memory directory at /memories.");
    expect(text.indexOf("Never keep: secrets")).toBeLessThan(
      text.indexOf("Keep release conventions."),
    );
    // Without harness.memory, nothing.
    expect(engineToolsFor({}, undefined, options).tools.map((tool) => tool.name)).not.toContain(
      "memory",
    );
  });

  it("is view-only for a read_only agent and for an agent used as a tool", () => {
    for (const memory of [
      { access: "read_only" as const, root: true },
      { access: "read_write" as const, root: false },
    ]) {
      const { tools, instructions } = engineToolsFor({}, undefined, options, memory);
      const tool = tools.find((item) => item.name === "memory")!;
      expect((tool.inputSchema.properties as any).command.enum).toEqual(["view"]);
      expect(tool.inputSchema.properties).not.toHaveProperty("file_text");
      expect(tool.description).not.toContain("create");
      expect(instructions.join("\n")).toContain("You may read it, not change it.");
    }
  });

  it("runs a call as a runtime effect, and takes memory.<command> as the tool", async () => {
    const { effects, prompts } = await turn(
      [
        { name: "memory", args: { command: "view", path: "/memories" } },
        { name: "memory.create", args: { path: "/memories/a.md", file_text: "x" } },
        { name: "memory/delete", args: { command: "delete", path: "/memories/b.md" } },
      ],
      undefined,
    );
    expect(effects.map((effect) => [effect.toolName, effect.target, effect.input])).toEqual([
      ["memory", { kind: "runtime", operation: "memory" }, { command: "view", path: "/memories" }],
      [
        "memory",
        { kind: "runtime", operation: "memory" },
        { command: "create", path: "/memories/a.md", file_text: "x" },
      ],
      [
        "memory",
        { kind: "runtime", operation: "memory" },
        { command: "delete", path: "/memories/b.md" },
      ],
    ]);
    // The conversation records the call as the tool it ran.
    expect(JSON.stringify(prompts[1])).not.toContain("memory.create");
  });

  it("answers a call missing a command's parameter, or naming another command, without sending it", async () => {
    const { effects, prompts } = await turn(
      [
        { name: "memory", args: { command: "create", path: "/memories/a.md" } },
        { name: "memory", args: { command: "insert", path: "/memories/a.md", insert_text: "x" } },
        {
          name: "memory.view",
          args: { command: "create", path: "/memories/a.md", file_text: "x" },
        },
      ],
      undefined,
    );
    expect(effects).toEqual([]);
    const next = JSON.stringify(prompts[1]);
    expect(next).toContain("Error: create requires file_text.");
    expect(next).toContain("Error: insert requires insert_line.");
    expect(next).toContain("Unknown Tool 'memory.view'. Call memory with command");
  });
});

describe("the pinned memory index", () => {
  const first = memoryIndexBlock({ index: "- /memories/a.md — A", truncated: false });

  it("goes after the instructions as user-role context, and stays as the session pinned it", async () => {
    const one = await turn([], [first]);
    const prompt = one.prompts[0]!;
    expect(prompt[0]).toMatchObject({ kind: "instructions", role: "system" });
    expect(prompt[1]).toMatchObject({ kind: "context", role: "user" });
    expect(texts(prompt)[1]).toBe(first);
    expect(texts(prompt)[1]).toContain("never overrides your instructions");
    expect(one.result.result.state.pinned).toEqual([first]);

    // The next turn keeps the block it pinned, though the Runtime's index changed.
    const later = memoryIndexBlock({
      index: "- /memories/b.md — B\n- /memories/a.md — A",
      truncated: true,
    });
    const two = await turn([], [later], one.result.result.state);
    expect(texts(two.prompts[0]!)[1]).toBe(first);

    // Memory turned off: the state drops it.
    const off = await turn([], undefined, one.result.result.state);
    expect(off.result.result.state.pinned).toBeUndefined();
    expect(off.prompts[0]!.filter((item) => item.kind === "context")).toEqual([]);
  });

  it("says when the memory is empty, and when older memories are left out", () => {
    expect(memoryIndexBlock({ index: "", truncated: false })).toContain(
      "Your memory directory (/memories) is empty.",
    );
    expect(memoryIndexBlock({ index: "- /memories/a.md", truncated: true })).toContain(
      "Older memories are not listed",
    );
  });
});
