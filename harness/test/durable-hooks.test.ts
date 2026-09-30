import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, implementationsFor, runHookPoint, type BuiltAgent } from "@nylorun/core/define";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../src/run/index.js";

/** A journaling host that answers hook effects the way the Action endpoint does. */
function hostFor(
  agent: BuiltAgent,
  options: {
    model: (call: number) => unknown;
    tool?: (effect: HostEffect) => unknown;
    pendingHooks?: boolean;
  },
) {
  const journal = new Map<string, EffectResolution>();
  const requests = new Map<string, HostEffect>();
  const effects: HostEffect[] = [];
  let models = 0;
  const host: DurableHost = {
    async resolveEffect(effect) {
      const recorded = journal.get(effect.effectId);
      if (recorded) {
        expect(effect).toEqual(requests.get(effect.effectId));
        return recorded;
      }
      requests.set(effect.effectId, effect);
      effects.push(effect);
      if (effect.kind === "hook" && options.pendingHooks) return { status: "pending" };
      const value =
        effect.kind === "model"
          ? options.model(models++)
          : effect.kind === "hook"
            ? { results: await runHookPoint(implementationsFor(agent), effect.hook!, effect.input) }
            : (options.tool?.(effect) ?? "ok");
      const resolution: EffectResolution = { status: "completed", outcome: { value } };
      journal.set(effect.effectId, resolution);
      return resolution;
    },
  };
  return { host, effects, journal };
}

const hookEffects = (effects: readonly HostEffect[]) =>
  effects.filter((effect) => effect.kind === "hook");

describe("durable hooks", () => {
  it("journals one effect per hook point per step for every capability", async () => {
    const seen: string[] = [];
    const agent = Agent({ id: "durable" })
      .use({
        id: "jobs",
        tools: [{ name: "job", inputSchema: z.object({}), execute: async () => "unused" }],
        before: { step: () => (seen.push("jobs"), {}) },
      })
      .use({ id: "audit", before: { step: () => (seen.push("audit"), {}) } })
      .use({ id: "policy", before: { step: () => (seen.push("policy"), {}) } })
      .build();
    const checkpoint = createDurableCheckpoint({
      manifest: agent.manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const { host, effects } = hostFor(agent, {
      model: (call) =>
        call === 0 ? { output: [{ type: "tool-call", id: "j", name: "job", args: {} }] } : "done",
    });
    const result = await runDurable({ manifest: agent.manifest, checkpoint, host });
    expect(result.status).toBe("completed");
    const hooks = hookEffects(effects);
    expect(hooks).toHaveLength(2);
    for (const hook of hooks)
      expect(hook.hook).toEqual({
        at: "before",
        scope: "step",
        capabilityIds: ["jobs", "audit", "policy"],
      });
    expect(hooks.map((hook) => hook.effectId)).toEqual([
      expect.stringMatching(/^turn:0:hook:before-step:step_/),
      expect.stringMatching(/^turn:0:hook:before-step:step_/),
    ]);
    expect(new Set(hooks.map((hook) => hook.effectId)).size).toBe(2);
    expect(seen).toHaveLength(6);
  });

  it("suspends on a pending hook and replays it under the same effect id", async () => {
    const agent = Agent({ id: "durable" })
      .use({ id: "one", before: { turn: () => ({}) } })
      .use({ id: "two", before: { turn: () => ({}) } })
      .build();
    const checkpoint = createDurableCheckpoint({
      manifest: agent.manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const { host, effects, journal } = hostFor(agent, {
      model: () => "done",
      pendingHooks: true,
    });
    const first = await runDurable({ manifest: agent.manifest, checkpoint, host });
    expect(first.status).toBe("waiting");
    if (!("effectIds" in first)) throw new Error("expected a suspended effect");
    expect(first.effectIds).toEqual(["turn:0:hook:before-turn"]);
    journal.set("turn:0:hook:before-turn", {
      status: "completed",
      outcome: { value: { results: { one: {}, two: {} } } },
    });
    const second = await runDurable({ manifest: agent.manifest, checkpoint, host });
    expect(second.status).toBe("completed");
    expect(hookEffects(effects)).toHaveLength(1);
  });

  it('does not issue before("turn") again in a resumed segment', async () => {
    const agent = Agent({ id: "durable" })
      .use({
        id: "pay",
        tools: [{ name: "refund", inputSchema: z.object({}), execute: async () => "unused" }],
        before: { turn: () => ({ instructions: ["TURN-RULE"] }), step: () => ({}) },
      })
      .build();
    const manifest = agent.manifest;
    const start = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      input: "go",
    });
    const segment0 = hostFor(agent, {
      model: () => ({ output: [{ type: "tool-call", id: "r", name: "refund", args: {} }] }),
      tool: () => ({
        kind: "interaction-required",
        interaction: { kind: "approval", prompt: "Refund?" },
        token: {},
      }),
    });
    const paused = await runDurable({ manifest, checkpoint: start, host: segment0.host });
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused" || paused.result.status !== "paused")
      throw new Error("expected pause");
    expect(paused.result.state.turn?.patch).toEqual({ instructions: ["TURN-RULE"] });
    const resume = createDurableCheckpoint({
      manifest,
      sessionId: "session",
      turnId: "turn",
      segment: 1,
      state: paused.result.state,
      input: {
        kind: "approve",
        interactionId: paused.result.pending[0]!.interaction!.id,
        approved: true,
      },
    });
    const prompts: string[] = [];
    const segment1 = hostFor(agent, {
      model: () => "done",
      tool: () => ({ kind: "completed", output: "refunded" }),
    });
    const wrapped: DurableHost = {
      resolveEffect: (effect) => {
        if (effect.kind === "model") prompts.push(JSON.stringify(effect.input));
        return segment1.host.resolveEffect(effect);
      },
    };
    const done = await runDurable({ manifest, checkpoint: resume, host: wrapped });
    expect(done.status).toBe("completed");
    const kinds = hookEffects(segment1.effects).map((effect) => effect.hook!.scope);
    expect(kinds).not.toContain("turn");
    expect(kinds).toContain("step");
    expect(prompts.at(-1)).toContain("TURN-RULE");
  });
});
