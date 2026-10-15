import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, hashManifest, type AgentManifest } from "@nylorun/core/define";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../src/run/index.js";
import { engineToolsFor } from "../src/tools/engine-tools.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "../src/tools/sandbox.js";
import { toolSet } from "./fixtures.js";

describe("durable reconstruction", () => {
  it.each(["pending", "uncertain"] as const)(
    "reuses completed effects and preserves the starting checkpoint for %s work",
    async (status) => {
      const agent = Agent({ id: "durable", name: "Durable" })
        .tools({ name: "job", inputSchema: z.object({}), execute: async () => "unused" })
        .build();
      const manifest = agent.manifest;
      const checkpoint = createDurableCheckpoint({
        manifest,
        sessionId: "session",
        turnId: "turn",
        input: "go",
      });
      const original = JSON.stringify(checkpoint);
      const journal = new Map<string, EffectResolution>();
      const requests = new Map<string, HostEffect>();
      const executions: string[] = [];
      let modelCalls = 0;
      const host: DurableHost = {
        async resolveEffect(effect) {
          const recorded = journal.get(effect.effectId);
          if (recorded) {
            expect(effect).toEqual(requests.get(effect.effectId));
            return recorded;
          }
          requests.set(effect.effectId, effect);
          executions.push(effect.kind);
          const resolution: EffectResolution =
            effect.kind === "model"
              ? {
                  status: "completed",
                  outcome: {
                    value:
                      modelCalls++ === 0
                        ? { output: [{ type: "tool-call", id: "job-call", name: "job", args: {} }] }
                        : "done",
                  },
                }
              : { status };
          journal.set(effect.effectId, resolution);
          return resolution;
        },
      };
      const first = await runDurable({ manifest, checkpoint, host });
      expect(first.status).toBe(status === "pending" ? "waiting" : "uncertain");
      expect(first.checkpoint).toBe(checkpoint);
      expect(JSON.stringify(checkpoint)).toBe(original);
      expect(executions).toEqual(["model", "tool"]);

      const replay = await runDurable({ manifest, checkpoint: JSON.parse(original), host });
      expect(replay).toEqual(first);
      expect(executions).toEqual(["model", "tool"]);

      if (!("effectIds" in first)) throw new Error("Expected suspended effect");
      expect(first.effectIds).toHaveLength(1);
      journal.set(first.effectIds[0]!, { status: "completed", outcome: { value: "settled" } });
      const completed = await runDurable({ manifest, checkpoint: JSON.parse(original), host });
      expect(completed.status).toBe("completed");
      expect(executions).toEqual(["model", "tool", "model"]);
      expect(JSON.stringify(checkpoint)).toBe(original);
    },
  );

  it("advertises session tools without changing the manifest hash", async () => {
    const agent = Agent({ id: "durable", name: "Durable" })
      .tools({ name: "job", inputSchema: z.object({}), execute: async () => "unused" })
      .build();
    const manifest = agent.manifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const names: string[][] = [];
    const toolEffects: HostEffect[] = [];
    const host: DurableHost = {
      async resolveEffect(effect) {
        if (effect.kind === "model") {
          const call = effect.input as { tools?: { name: string }[]; prompt?: { kind?: string }[] };
          names.push((call.tools ?? []).map((tool) => tool.name));
          const last = call.prompt?.at(-1);
          if (last?.kind === "tool-result")
            return {
              status: "completed",
              outcome: { value: { output: [{ type: "text", text: "done" }] } },
            };
          return {
            status: "completed",
            outcome: {
              value: {
                output: [
                  {
                    type: "tool-call",
                    id: "issue-call",
                    name: "github__get_issue",
                    args: { number: 7 },
                  },
                ],
              },
            },
          };
        }
        toolEffects.push(effect);
        return {
          status: "completed",
          outcome: { value: { kind: "completed", output: { title: "bug" } } },
        };
      },
    };
    const result = await runDurable({
      manifest,
      checkpoint,
      host,
      mcp: toolSet([
        {
          name: "github__get_issue",
          description: "Read an issue.",
          inputSchema: {
            type: "object",
            properties: { number: { type: "integer" } },
            required: ["number"],
          },
          target: { kind: "mcp", server: "github", tool: "get_issue" },
        },
      ]),
    });
    expect(result.status).toBe("completed");
    expect(names[0]).toEqual(["job", "github__get_issue"]);
    // A session tool's effect is named by the tool alone (protocol 13).
    expect(toolEffects).toHaveLength(1);
    expect(toolEffects[0]).toMatchObject({
      kind: "tool",
      toolName: "github__get_issue",
      input: { number: 7 },
    });
    expect(toolEffects[0]).not.toHaveProperty("capabilityId");
    expect(JSON.stringify(manifest)).not.toContain("github__get_issue");
    expect(checkpoint.manifestHash).toBe(hashManifest(manifest));
  });
});

describe("our engine's own tools (protocol 15)", () => {
  const sandboxed = { id: "env", kind: "virtual" as const, sandbox: { workspace: "/workspace" } };
  const options = {
    artifactPageBytes: 1024,
    sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS,
    skillReadBytes: 1024,
  };
  const skill = {
    name: "pdf",
    description: "PDFs.",
    files: { "SKILL.md": `sha256:${"a".repeat(64)}` },
  };

  it("offers them after the agent's and before the session's, with their text first, unhashed", async () => {
    const definition = Agent({ id: "coder" })
      .instructions("Fix the tests.")
      .tools({ name: "job", inputSchema: z.object({}), execute: async () => "unused" })
      .build().manifest;
    const manifest = { ...definition, skills: { pdf: skill } } as AgentManifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "s",
      turnId: "t",
      input: "go",
    });
    const offered: string[][] = [];
    const prompts: string[] = [];
    const tools: HostEffect[] = [];
    const host: DurableHost = {
      async resolveEffect(effect) {
        if (effect.kind === "model") {
          const call = effect.input as { tools: { name: string }[]; prompt: { kind?: string }[] };
          offered.push(call.tools.map((tool) => tool.name));
          prompts.push(JSON.stringify(call.prompt));
          const output =
            call.prompt.at(-1)?.kind === "tool-result"
              ? [{ type: "text", text: "done" }]
              : [
                  {
                    type: "tool-call",
                    id: "r",
                    name: "read_artifact",
                    args: { artifactId: "af_1" },
                  },
                  {
                    type: "tool-call",
                    id: "b",
                    name: "bash",
                    args: { command: "cat /skills/pdf/SKILL.md" },
                  },
                  { type: "tool-call", id: "l", name: "load_skill", args: { name: "pdf" } },
                  { type: "tool-call", id: "g", name: "github__get_issue", args: {} },
                  { type: "tool-call", id: "j", name: "job", args: {} },
                ];
          return { status: "completed", outcome: { value: { output } } };
        }
        tools.push(effect);
        return { status: "completed", outcome: { value: { kind: "completed", output: "ok" } } };
      },
    };
    const result = await runDurable({
      manifest,
      checkpoint,
      host,
      engineTools: (agent) => engineToolsFor(agent, sandboxed, options),
      mcp: toolSet([
        {
          name: "github__get_issue",
          inputSchema: { type: "object" },
          instructions: ["MCP note."],
          target: { kind: "mcp", server: "github", tool: "get_issue" },
        },
      ]),
    });
    expect(result.status).toBe("completed");
    expect(offered[0]).toEqual([
      "job",
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "load_skill",
      "save_artifact",
      "read_artifact",
      "github__get_issue",
    ]);
    // The agent's text, then the skills', the sandbox's, the artifacts', then the session tools'.
    const prompt = prompts[0]!;
    const order = [
      "Fix the tests.",
      "The following skills",
      "You have an isolated Linux sandbox",
      "Each skill's files are in the sandbox",
      "Use save_artifact",
      "Use read_artifact",
      "MCP note.",
    ].map((text) => prompt.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Each call names what runs it; the skill a call ran comes with it. The author's code tool
    // names nothing: the record fails it.
    const byName = Object.fromEntries(tools.map((effect) => [effect.toolName, effect]));
    expect(byName.read_artifact).toMatchObject({ target: { kind: "harness" } });
    expect(byName.read_artifact).not.toHaveProperty("skill");
    expect(byName.bash).toMatchObject({ target: { kind: "sandbox" }, skill: "pdf" });
    expect(byName.load_skill).toMatchObject({ target: { kind: "harness" }, skill: "pdf" });
    expect(byName.github__get_issue).toMatchObject({ target: { kind: "mcp" } });
    expect(byName.job).not.toHaveProperty("target");
    // The hash is the definition's: nothing of ours is in the manifest.
    expect(checkpoint.manifestHash).toBe(hashManifest(manifest));
    // Without a sandbox: the skill tools and read_artifact, without path.
    const bare = engineToolsFor(manifest, undefined, options);
    expect(bare.tools.map((tool) => tool.name)).toEqual(["load_skill", "read_artifact"]);
    expect(Object.keys(bare.tools[1]!.inputSchema.properties as object)).not.toContain("path");
    expect(bare.instructions.join("\n")).not.toContain("sandbox, read-only");
  });

  it("fails the turn when an author tool takes the name of one of ours, and runs it without a sandbox", async () => {
    const manifest = Agent({ id: "coder" })
      .tools({ name: "bash", inputSchema: z.object({}), execute: async () => "unused" })
      .build().manifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "s",
      turnId: "t",
      input: "go",
    });
    const host: DurableHost = {
      async resolveEffect() {
        return {
          status: "completed",
          outcome: { value: { output: [{ type: "text", text: "done" }] } },
        };
      },
    };
    await expect(
      runDurable({
        manifest,
        checkpoint,
        host,
        engineTools: (agent) => engineToolsFor(agent, sandboxed, options),
      }),
    ).rejects.toMatchObject({
      code: "agent.build-failed",
      message: expect.stringContaining("'bash'"),
    });
    const bare = await runDurable({
      manifest,
      checkpoint,
      host,
      engineTools: (agent) => engineToolsFor(agent, undefined, options),
    });
    expect(bare.status).toBe("completed");
  });
});

describe("model failure outcomes (Model Calls §6)", () => {
  const agent = () => Agent({ id: "failing", name: "Failing" }).build();

  it("fails the turn with model.<code> when the model effect completed with a failure", async () => {
    const manifest = agent().manifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const host: DurableHost = {
      async resolveEffect() {
        return {
          status: "completed",
          outcome: {
            value: {
              kind: "failed",
              code: "overloaded",
              message: "The server is overloaded",
              retryable: true,
            },
          },
        };
      },
    };
    const result = await runDurable({ manifest, checkpoint, host });
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      result: {
        status: "failed",
        error: { code: "model.overloaded", message: "The server is overloaded" },
      },
    });
  });

  it("rejects a checkpoint from the previous engine version", async () => {
    const manifest = agent().manifest;
    const checkpoint = {
      ...createDurableCheckpoint({ manifest, sessionId: "session", turnId: "turn", input: "go" }),
      engineVersion: "hosted-2",
    } as unknown as Parameters<typeof runDurable>[0]["checkpoint"];
    await expect(
      runDurable({
        manifest,
        checkpoint,
        host: { resolveEffect: async () => ({ status: "pending" }) },
      }),
    ).rejects.toMatchObject({ code: "execution.incompatible" });
  });
});

describe("segment rollover (Model Calls §10)", () => {
  it("yields between steps and continues the same turn in the next segment", async () => {
    const manifest = Agent({ id: "roller", name: "Roller" })
      .tools({ name: "job", inputSchema: z.object({}), execute: async () => "unused" })
      .build().manifest;
    const journal = new Map<string, EffectResolution>();
    let modelCalls = 0;
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        const value =
          effect.kind === "tool"
            ? { kind: "completed", output: "ok" }
            : modelCalls++ < 5
              ? { output: [{ type: "tool-call", id: `c${modelCalls}`, name: "job", args: {} }] }
              : "done";
        const resolution: EffectResolution = { status: "completed", outcome: { value } };
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };
    let checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const statuses: string[] = [];
    for (;;) {
      const result = await runDurable({ manifest, checkpoint, host, yieldAfter: { steps: 2 } });
      statuses.push(result.status);
      if (result.status !== "yielded") {
        expect(result.status).toBe("completed");
        const transcript = (result as any).result.state.transcript as { turnId: string }[];
        // One engine turn across every segment.
        expect(new Set(transcript.map((entry) => entry.turnId)).size).toBe(1);
        break;
      }
      checkpoint = {
        ...result.checkpoint,
        segment: result.checkpoint.segment + 1,
        input: { kind: "continue" },
      };
    }
    expect(statuses).toEqual(["yielded", "yielded", "completed"]);
    expect(modelCalls).toBe(6);
    // Effect ids carry the segment, so no segment reads another's journal.
    expect(new Set([...journal.keys()].map((id) => id.split(":")[1])).size).toBe(3);
  });
});
