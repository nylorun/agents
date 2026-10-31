/**
 * `update_plan` (A2A profile v2, `progress/v1`): offered to the root agent when the session's
 * version sets `harness.loop.plan` (`turn.start.loop.plan`); each call claims one `plan.updated`
 * with the whole plan, cut to the limits, and answers `Plan updated`; a malformed plan is a failed
 * outcome and claims nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type AgentManifest } from "@nylorun/core/define";
import { PLAN_LIMITS, PlanUpdatedPayloadSchema } from "@nylorun/core/contracts";
import {
  HARNESS_API_VERSION,
  HARNESS_CLAIMS,
  HarnessApiError,
  RUNTIME_LIMIT_DEFAULTS,
  memoryChannels,
  type HarnessChannel,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { createHarness, type Harness, type HarnessExecutors } from "../src/api/index.js";
import type { HarnessRun } from "../src/api/executors.js";
import { createDurableCheckpoint, type HostEffect } from "../src/run/index.js";
import { engineToolsFor } from "../src/tools/engine-tools.js";
import { cut, planOf, runPlanTool, UPDATE_PLAN_TOOL } from "../src/tools/plan.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "../src/tools/sandbox.js";

const options = {
  artifactPageBytes: 1024,
  sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS,
  skillReadBytes: 1024,
};

const names = (agent: Pick<AgentManifest, "skills" | "tools">, plan?: boolean) =>
  engineToolsFor(agent, undefined, options, undefined, plan).tools.map((tool) => tool.name);

describe("the plan", () => {
  it("keeps label, state and note, trimmed", () => {
    expect(
      planOf({
        steps: [
          { label: " Inspect wikis ", state: "done", note: "Node 22, pnpm 9" },
          { label: "Build in parts", state: "active", note: "  " },
          { label: "Package", state: "pending" },
        ],
      }),
    ).toEqual({
      steps: [
        { label: "Inspect wikis", state: "done", note: "Node 22, pnpm 9" },
        { label: "Build in parts", state: "active" },
        { label: "Package", state: "pending" },
      ],
      dropped: 0,
    });
    expect(planOf({ steps: [] })).toEqual({ steps: [], dropped: 0 });
  });

  it("cuts labels, notes and steps past the limits instead of refusing them", () => {
    const steps = Array.from({ length: 25 }, (_, n) => ({
      label: `${n}`.padEnd(500, "l"),
      state: "pending",
      note: "n".repeat(1_000),
    }));
    const plan = planOf({ steps });
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.dropped).toBe(5);
    expect(plan.steps).toHaveLength(PLAN_LIMITS.steps);
    expect(plan.steps[0]!.label).toHaveLength(PLAN_LIMITS.labelChars);
    expect(plan.steps[0]!.label.endsWith("…")).toBe(true);
    expect(plan.steps[0]!.note).toHaveLength(PLAN_LIMITS.noteChars);
    expect(plan.steps.at(-1)!.label.startsWith("19")).toBe(true);
    expect(PlanUpdatedPayloadSchema.safeParse({ steps: plan.steps }).success).toBe(true);
  });

  it("never cuts inside a surrogate pair", () => {
    const text = `${"a".repeat(118)}😀😀`;
    const out = cut(text, 120);
    expect(out).toBe(`${"a".repeat(118)}…`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(cut("short", 120)).toBe("short");
  });

  it("names what is wrong with a malformed plan", () => {
    expect(planOf({})).toMatch(/Give steps/);
    expect(planOf(undefined)).toMatch(/Give steps/);
    expect(planOf({ steps: [{ label: "", state: "done" }] })).toBe("Step 1 has no label.");
    expect(
      planOf({
        steps: [
          { label: "a", state: "done" },
          { label: "b", state: "finished" },
        ],
      }),
    ).toMatch(/^Step 2's state is one of pending, active, done, blocked, skipped/);
    expect(planOf({ steps: [{ label: "a", state: "done", note: 3 }] })).toBe(
      "Step 1's note is text.",
    );
  });
});

describe("the plan.updated event", () => {
  it("is in the catalog and a harness may claim it", () => {
    expect(HARNESS_CLAIMS).toContain("plan.updated");
    const ok = { steps: [{ label: "Build", state: "active", note: "half" }] };
    expect(PlanUpdatedPayloadSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { steps: [{ label: "Build", state: "finished" }] },
      { steps: [{ label: "", state: "done" }] },
      { steps: [{ label: "x".repeat(PLAN_LIMITS.labelChars + 1), state: "done" }] },
      { steps: [{ label: "x", state: "done", note: "n".repeat(PLAN_LIMITS.noteChars + 1) }] },
      {
        steps: Array.from({ length: PLAN_LIMITS.steps + 1 }, () => ({ label: "x", state: "done" })),
      },
      {},
    ])
      expect(PlanUpdatedPayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe("update_plan in our engine's tools", () => {
  it("is off by default, and offered last when the version opts in", () => {
    expect(names({})).not.toContain(UPDATE_PLAN_TOOL);
    expect(names({}, false)).not.toContain(UPDATE_PLAN_TOOL);
    const { tools, instructions } = engineToolsFor({}, undefined, options, undefined, true);
    const tool = tools.at(-1)!;
    expect(tool.name).toBe(UPDATE_PLAN_TOOL);
    expect(tool.target).toEqual({ kind: "harness" });
    expect(tool.inputSchema).toMatchObject({
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          items: {
            required: ["label", "state"],
            properties: { state: { enum: ["pending", "active", "done", "blocked", "skipped"] } },
          },
        },
      },
    });
    expect(instructions.at(-1)).toContain("update_plan");
  });

  it("leaves an agent that has its own update_plan tool with its own", () => {
    const agent = {
      tools: [{ name: UPDATE_PLAN_TOOL, description: "Mine", inputSchema: { type: "object" } }],
    } as unknown as Pick<AgentManifest, "tools">;
    expect(names(agent, true)).not.toContain(UPDATE_PLAN_TOOL);
  });
});

describe("a call of update_plan", () => {
  const run = {
    runId: "r1",
    grant: { sessionId: "s1", turnId: "t1" },
    start: {},
    signal: new AbortController().signal,
  } as unknown as HarnessRun;
  const effect = (input: unknown) =>
    ({
      kind: "tool",
      effectId: "t1:0:tool:c0",
      toolName: UPDATE_PLAN_TOOL,
      target: { kind: "harness" },
      input,
    }) as unknown as HostEffect;
  const channelOf = (answer: () => unknown) => {
    const requests: [string, any][] = [];
    const channel = {
      async request(method: string, params: unknown) {
        requests.push([method, params]);
        return answer();
      },
    } as unknown as Pick<HarnessChannel, "request">;
    return { channel, requests };
  };

  it("claims plan.updated for the run's turn and answers Plan updated", async () => {
    const { channel, requests } = channelOf(() => ({}));
    const outcome = await runPlanTool(effect({ steps: [{ label: "Build", state: "active" }] }), {
      channel,
      run,
      signal: run.signal,
    });
    expect(outcome).toEqual({ kind: "completed", output: "Plan updated" });
    expect(requests).toEqual([
      [
        "event",
        {
          runId: "r1",
          sessionId: "s1",
          turnId: "t1",
          type: "plan.updated",
          payload: { steps: [{ label: "Build", state: "active" }] },
        },
      ],
    ]);
  });

  it("says when steps past the limit were left out", async () => {
    const { channel, requests } = channelOf(() => ({}));
    const steps = Array.from({ length: 22 }, (_, n) => ({ label: `s${n}`, state: "pending" }));
    const outcome = await runPlanTool(effect({ steps }), { channel, run, signal: run.signal });
    expect(outcome).toEqual({
      kind: "completed",
      output: "Plan updated: only the first 20 steps were kept.",
    });
    expect(requests[0]![1].payload.steps).toHaveLength(20);
  });

  it("fails a malformed plan to the model and claims nothing", async () => {
    const { channel, requests } = channelOf(() => ({}));
    const outcome = await runPlanTool(effect({ steps: [{ label: "a", state: "nope" }] }), {
      channel,
      run,
      signal: run.signal,
    });
    expect(outcome).toMatchObject({ kind: "failed", code: "plan.invalid_input" });
    expect(requests).toEqual([]);
  });

  it("fails a claim the Runtime refuses to the model, and throws for a run it lost", async () => {
    const refused = channelOf(() => {
      throw new HarnessApiError("invalid", "A harness may not claim plan.updated");
    });
    expect(
      await runPlanTool(effect({ steps: [] }), {
        channel: refused.channel,
        run,
        signal: run.signal,
      }),
    ).toMatchObject({ kind: "failed", code: "plan.not_recorded" });
    const lost = channelOf(() => {
      throw new HarnessApiError("run_not_held", "gone");
    });
    await expect(
      runPlanTool(effect({ steps: [] }), { channel: lost.channel, run, signal: run.signal }),
    ).rejects.toThrow("gone");
  });
});

// --- Through the Harness API: turn.start.loop.plan, the claim, and a replay -----------------------

const manifest = Agent({ id: "bot", name: "Bot" }).build().manifest;

function start(fields: Partial<TurnStart> = {}): TurnStart {
  return {
    type: "turn.start",
    engine: "agent",
    manifest,
    checkpoint: createDurableCheckpoint({ manifest, sessionId: "s1", turnId: "t1", input: "go" }),
    outcomes: [],
    transcript: { cursor: -1 },
    options: { fixtureModel: false },
    routing: { rootManifest: manifest },
    limits: RUNTIME_LIMIT_DEFAULTS,
    ...fields,
  };
}

/** A fake core over a validating channel: offers one start at a time and records every request. */
function fakeCore() {
  const channels = memoryChannels({ json: true });
  const calls: [string, any][] = [];
  const outputs: [string, any][] = [];
  let offer: { start: TurnStart; turnId: string } | undefined;
  let lease: ((value: unknown) => void) | undefined;
  let settled: (() => void) | undefined;
  let runs = 0;
  const flush = () => {
    if (!offer || !lease) return;
    runs += 1;
    lease({
      run: { runId: `r${runs}`, sessionId: "s1", turnId: offer.turnId, epoch: 1 },
      input: offer.start,
    });
    offer = undefined;
    lease = undefined;
  };
  channels.core.handle(async (method, params: any) => {
    calls.push([method, params]);
    switch (method) {
      case "hello":
        return {
          api: HARNESS_API_VERSION,
          tenantId: "tn_test",
          sandbox: { backend: null },
          renewEveryMs: 1000,
        };
      case "lease":
        return new Promise((resolve) => {
          lease = resolve;
          flush();
        });
      case "effect.intent":
        return { status: "execute" };
      case "effect.outcome":
        return { status: "completed", outcome: { value: params.value } };
      case "event":
      case "lease.release":
        return {};
      case "lease.renew":
        return { ok: true };
      default:
        outputs.push([method, params]);
        settled?.();
        return { cursor: 7 };
    }
  });
  return {
    channel: channels.harness,
    calls,
    outputs,
    offer(turnStart: TurnStart, turnId = "t1") {
      const done = new Promise<void>((resolve) => (settled = resolve));
      offer = { start: turnStart, turnId };
      flush();
      return done;
    },
  };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

/** A model that calls update_plan in its first step, then answers "done"; it records each step's tools. */
function planningModel(tools: string[][]): HarnessExecutors["model"] {
  return async (effect) => {
    const call = effect.input as { tools: { name: string }[] };
    tools.push(call.tools.map((tool) => tool.name));
    return tools.length === 1 && call.tools.some((tool) => tool.name === UPDATE_PLAN_TOOL)
      ? {
          output: [
            {
              type: "tool-call",
              id: "c0",
              name: UPDATE_PLAN_TOOL,
              args: {
                steps: [
                  { label: "Inspect wikis and toolchain", state: "done", note: "Node 22, pnpm 9" },
                  { label: "x".repeat(300), state: "active" },
                ],
              },
            },
          ],
        }
      : { output: [{ type: "text", text: "done" }] };
  };
}

describe("update_plan over the Harness API", () => {
  it("is offered when turn.start.loop.plan is true, and each call claims plan.updated", async () => {
    const core = fakeCore();
    const tools: string[][] = [];
    const executors: HarnessExecutors = {
      model: planningModel(tools),
      tool: async () => "tool",
      recovers: { model: false, tool: () => false },
    };
    const harness = createHarness({ channel: core.channel, executors });
    harnesses.push(harness);
    await harness.start();

    await core.offer(start({ loop: { plan: true } }));
    expect(tools[0]).toContain(UPDATE_PLAN_TOOL);
    const claims = core.calls.filter(([method]) => method === "event");
    expect(claims).toHaveLength(1);
    const claim = claims[0]![1];
    expect(claim).toMatchObject({
      runId: "r1",
      sessionId: "s1",
      turnId: "t1",
      type: "plan.updated",
    });
    expect(PlanUpdatedPayloadSchema.parse(claim.payload).steps).toEqual([
      { label: "Inspect wikis and toolchain", state: "done", note: "Node 22, pnpm 9" },
      { label: `${"x".repeat(119)}…`, state: "active" },
    ]);
    const intent = core.calls.find(
      ([method, params]) =>
        method === "effect.intent" && params.effect.toolName === UPDATE_PLAN_TOOL,
    )![1];
    expect(intent.effect.target).toEqual({ kind: "harness" });
    const outcome = core.calls.find(
      ([method, params]) =>
        method === "effect.outcome" && params.effectId === intent.effect.effectId,
    )![1];
    expect(outcome.value).toEqual({ kind: "completed", output: "Plan updated" });
    expect(core.outputs.at(-1)![0]).toBe("turn.completed");

    // A replayed call answers its recorded outcome and claims nothing again.
    core.calls.length = 0;
    tools.length = 0;
    await core.offer(
      start({
        loop: { plan: true },
        outcomes: [
          {
            effectId: intent.effect.effectId,
            requestHash: intent.requestHash,
            outcome: { value: outcome.value },
          },
        ],
      }),
      "t1",
    );
    expect(core.calls.filter(([method]) => method === "event")).toHaveLength(0);
  });

  it("is not offered without it", async () => {
    const core = fakeCore();
    const tools: string[][] = [];
    const harness = createHarness({
      channel: core.channel,
      executors: {
        model: planningModel(tools),
        tool: async () => "tool",
        recovers: { model: false, tool: () => false },
      },
    });
    harnesses.push(harness);
    await harness.start();
    await core.offer(start());
    await core.offer(start({ loop: { plan: false } }), "t2");
    expect(tools.flat()).not.toContain(UPDATE_PLAN_TOOL);
    expect(core.calls.filter(([method]) => method === "event")).toHaveLength(0);
  });
});
