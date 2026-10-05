import { describe, expect, it } from "vitest";
import { Agent, Loop, hashManifest } from "@nylorun/core/define";
import type { AgentManifest } from "@nylorun/core/define";
import { z } from "zod";
import {
  agentTurnValue,
  createFlowCheckpoint,
  runFlowDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../../src/run/index.js";

describe("flow Loop (tracer)", () => {
  it("runs two iterations through agent → verify → decide effects", async () => {
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: ({ iteration }) =>
        iteration === 1 ? { pass: false, feedback: "try again" } : { pass: true },
      decide: ({ verdict, output }) => (verdict.pass ? { output } : { input: verdict.feedback }),
    });
    const manifest = workflow.manifest;
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "wf-1",
      turnId: "turn-1",
      input: "draft",
    });
    expect(checkpoint.manifestHash).toBe(hashManifest(manifest));

    const journal = new Map<string, EffectResolution>();
    const kinds: string[] = [];
    const host: DurableHost = {
      async resolveEffect(effect: HostEffect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        kinds.push(`${effect.kind}@${effect.iterations}`);
        let resolution: EffectResolution;
        if (effect.kind === "agent") {
          const n = Number(effect.iterations);
          resolution = {
            status: "completed",
            outcome: { value: n === 1 ? "draft-v1" : "draft-v2" },
          };
        } else if (effect.kind === "verify") {
          const input = effect.input as { iteration: number };
          resolution = {
            status: "completed",
            outcome: {
              value:
                input.iteration === 1 ? { pass: false, feedback: "try again" } : { pass: true },
            },
          };
        } else if (effect.kind === "fn") {
          const input = effect.input as {
            verdict: { pass: boolean; feedback?: string };
            output: string;
          };
          resolution = {
            status: "completed",
            outcome: {
              value: input.verdict.pass
                ? { output: input.output }
                : { input: input.verdict.feedback },
            },
          };
        } else {
          throw new Error(`unexpected ${effect.kind}`);
        }
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };

    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result).toEqual({ status: "completed", output: "draft-v2" });
    expect(kinds).toEqual(["agent@1", "verify@1", "fn@1", "agent@2", "verify@2", "fn@2"]);

    // Replay reuses journaled effects; no extra host work.
    const replay = await runFlowDurable({ manifest, checkpoint, host });
    expect(replay).toEqual(result);
    expect(kinds).toHaveLength(6);
  });

  it("returns waiting when the agent effect is pending, then resumes", async () => {
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: () => ({ pass: true }),
      decide: ({ output }) => ({ output }),
    });
    const manifest = workflow.manifest;
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "wf-1",
      turnId: "turn-1",
      input: "hi",
    });
    const journal = new Map<string, EffectResolution>();
    let agentEffectId = "";
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        if (effect.kind === "agent") {
          agentEffectId = effect.effectId;
          const pending = { status: "pending" as const };
          journal.set(effect.effectId, pending);
          return pending;
        }
        const completed = {
          status: "completed" as const,
          outcome: {
            value: effect.kind === "verify" ? { pass: true } : { output: "done" },
          },
        };
        journal.set(effect.effectId, completed);
        return completed;
      },
    };

    const first = await runFlowDurable({ manifest, checkpoint, host });
    expect(first.status).toBe("waiting");
    if (!("effectIds" in first)) throw new Error("expected waiting");
    expect(first.effectIds).toEqual([agentEffectId]);

    journal.set(agentEffectId, {
      status: "completed",
      outcome: { value: "done" },
    });
    const second = await runFlowDurable({ manifest, checkpoint, host });
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("expected completed");
    expect(second.result).toEqual({ status: "completed", output: "done" });
  });

  it("carries decide agent patches to the next agent effect (LOOP-R8, LOOP-R9)", async () => {
    const coder = Agent({ id: "coder", instructions: "Fix." })
      .use({
        id: "tools",
        tools: [
          {
            name: "deploy",
            inputSchema: z.object({}),
            execute: async () => "ok",
          },
        ],
      })
      .build();
    const pinned = coder.manifest;
    const withoutDeploy: AgentManifest = {
      ...pinned,
      capabilities: pinned.capabilities.map((capability) =>
        capability.id === "tools"
          ? { ...capability, tools: [], instructions: ["No deploy."] }
          : capability,
      ),
    };
    const seenManifests: unknown[] = [];
    const seenDecideAgents: unknown[] = [];
    const workflow = Loop({
      id: "fix",
      run: coder,
      verify: ({ iteration }) =>
        iteration === 1
          ? { pass: false as const, feedback: "deploy broke" }
          : { pass: true as const },
      decide: ({ agent, verdict, output }) => {
        seenDecideAgents.push(agent?.capabilities.find((c) => c.id === "tools")?.tools?.length);
        if (verdict.pass) return { output };
        return { input: verdict.feedback, agent: withoutDeploy };
      },
    });
    const journal = new Map<string, EffectResolution>();
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        let resolution: EffectResolution;
        if (effect.kind === "agent") {
          const body = effect.input as { manifest?: AgentManifest };
          seenManifests.push(body.manifest ?? null);
          const turn = body.manifest ?? pinned;
          resolution = {
            status: "completed",
            outcome: {
              value: agentTurnValue(Number(effect.iterations) === 1 ? "v1" : "v2", turn),
            },
          };
        } else if (effect.kind === "verify") {
          const input = effect.input as { iteration: number };
          resolution = {
            status: "completed",
            outcome: {
              value:
                input.iteration === 1 ? { pass: false, feedback: "deploy broke" } : { pass: true },
            },
          };
        } else {
          const input = effect.input as {
            verdict: { pass: boolean; feedback?: string };
            output: string;
            agent?: AgentManifest;
          };
          const decision = workflow.getBinding().nodes["fix/decide"]!.fn(input as never);
          resolution = { status: "completed", outcome: { value: decision } };
        }
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };
    const result = await runFlowDurable({
      manifest: workflow.manifest,
      checkpoint: createFlowCheckpoint({
        manifest: workflow.manifest,
        sessionId: "wf",
        turnId: "t",
        input: "task",
      }),
      host,
    });
    expect(result.status).toBe("completed");
    expect(seenManifests).toEqual([null, withoutDeploy]);
    expect(seenDecideAgents).toEqual([
      pinned.capabilities.find((c) => c.id === "tools")?.tools?.length,
      0,
    ]);
  });

  it("fails with loop.invalid-agent when decide returns a non-variant (LOOP-R21, WF-E11)", async () => {
    const coder = Agent({ id: "coder", instructions: "Fix." })
      .use({
        id: "policy",
        tools: [
          {
            name: "deploy",
            inputSchema: z.object({}),
            execute: async () => "ok",
          },
        ],
        mcpServers: { gh: { name: "gh", type: "streamable-http", url: "https://x.example/mcp" } },
      })
      .build();
    const pinned = coder.manifest;
    const strippedMcp: AgentManifest = {
      ...pinned,
      capabilities: pinned.capabilities.map((capability) =>
        capability.id === "policy"
          ? { id: "policy", type: "agent", tools: capability.tools }
          : capability,
      ),
    };
    const workflow = Loop({
      id: "fix",
      run: coder,
      verify: () => ({ pass: false as const, feedback: "no" }),
      decide: () => ({ input: "retry", agent: strippedMcp }),
    });
    const journal = new Map<string, EffectResolution>();
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        let resolution: EffectResolution;
        if (effect.kind === "agent") {
          resolution = {
            status: "completed",
            outcome: { value: agentTurnValue("out", pinned) },
          };
        } else if (effect.kind === "verify") {
          resolution = {
            status: "completed",
            outcome: { value: { pass: false, feedback: "no" } },
          };
        } else {
          const input = effect.input as never;
          const decision = workflow.getBinding().nodes["fix/decide"]!.fn(input);
          resolution = { status: "completed", outcome: { value: decision } };
        }
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };
    const result = await runFlowDurable({
      manifest: workflow.manifest,
      checkpoint: createFlowCheckpoint({
        manifest: workflow.manifest,
        sessionId: "wf",
        turnId: "t",
        input: "task",
      }),
      host,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.result).toMatchObject({
      status: "failed",
      error: { code: "loop.invalid-agent" },
    });
  });

  it("passes verify args { input, output, iteration } (LOOP-R3)", async () => {
    const seen: unknown[] = [];
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: (args) => {
        seen.push(args);
        return { pass: true as const };
      },
      decide: ({ output }) => ({ output }),
    });
    const journal = new Map<string, EffectResolution>();
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        let resolution: EffectResolution;
        if (effect.kind === "agent") {
          resolution = { status: "completed", outcome: { value: "draft" } };
        } else if (effect.kind === "verify") {
          const value = await workflow.getBinding().nodes.polish!.fn(effect.input as never);
          resolution = { status: "completed", outcome: { value } };
        } else {
          resolution = {
            status: "completed",
            outcome: { value: { output: "draft" } },
          };
        }
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };
    await runFlowDurable({
      manifest: workflow.manifest,
      checkpoint: createFlowCheckpoint({
        manifest: workflow.manifest,
        sessionId: "wf",
        turnId: "t",
        input: "loop-input",
      }),
      host,
    });
    expect(seen).toEqual([{ input: "loop-input", output: "draft", iteration: 1 }]);
  });

  it("loop.too-many-iterations stops runaway Loop (LOOP-A8,WF-E13,WF-L3)", async () => {
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: () => ({ pass: false, feedback: "again" }),
      decide: ({ verdict }) => ({ input: verdict.feedback ?? "again" }),
    });
    const journal = new Map<string, EffectResolution>();
    let agentStarts = 0;
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        let resolution: EffectResolution;
        if (effect.kind === "agent") {
          agentStarts += 1;
          resolution = {
            status: "completed",
            outcome: { value: `draft-v${effect.iterations}` },
          };
        } else if (effect.kind === "verify") {
          resolution = {
            status: "completed",
            outcome: { value: { pass: false, feedback: "again" } },
          };
        } else {
          resolution = {
            status: "completed",
            outcome: { value: { input: "again" } },
          };
        }
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };
    const result = await runFlowDurable({
      manifest: workflow.manifest,
      checkpoint: createFlowCheckpoint({
        manifest: workflow.manifest,
        sessionId: "wf",
        turnId: "t",
        input: "draft",
      }),
      host,
      limits: { maxLoopIterations: 3 },
    });
    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        error: { code: "loop.too-many-iterations", path: "polish" },
      },
    });
    // Iterations 1..3 ran; iteration 4 was rejected before starting.
    expect(agentStarts).toBe(3);
  });
});
