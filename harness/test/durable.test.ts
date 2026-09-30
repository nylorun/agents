import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, hashManifest } from "@nylorun/core/define";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../src/run/index.js";

describe("durable reconstruction", () => {
  it.each(["pending", "uncertain"] as const)(
    "reuses completed effects and preserves the starting checkpoint for %s work",
    async (status) => {
      const agent = Agent({ id: "durable", name: "Durable" })
        .use({
          id: "jobs",
          tools: [{ name: "job", inputSchema: z.object({}), execute: async () => "unused" }],
        })
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
      .use({
        id: "jobs",
        tools: [{ name: "job", inputSchema: z.object({}), execute: async () => "unused" }],
      })
      .build();
    const manifest = agent.manifest;
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const names: string[][] = [];
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
        expect(effect).toMatchObject({
          kind: "tool",
          capabilityId: "jobs",
          toolName: "github__get_issue",
          input: { number: 7 },
        });
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
      sessionTools: [
        {
          capabilityId: "jobs",
          name: "github__get_issue",
          description: "Read an issue.",
          inputSchema: {
            type: "object",
            properties: { number: { type: "integer" } },
            required: ["number"],
          },
        },
      ],
    });
    expect(result.status).toBe("completed");
    expect(names[0]).toEqual(["job", "github__get_issue"]);
    expect(JSON.stringify(manifest)).not.toContain("github__get_issue");
    expect(checkpoint.manifestHash).toBe(hashManifest(manifest));
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
      .use({
        id: "jobs",
        tools: [{ name: "job", inputSchema: z.object({}), execute: async () => "unused" }],
      })
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
