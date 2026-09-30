import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WorkflowManifest } from "@nylorun/core/contracts";
import {
  Agent,
  Chain,
  Loop,
  Map as MapNode,
  Switch,
  tool,
  type BuiltWorkflow,
  type JsonValue,
} from "@nylorun/core/define";
import {
  createFlowCheckpoint,
  runFlowDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../../src/run/index.js";
import {
  flowEffectId,
  iterationsOf,
  joinPath,
  mapItemPath,
  nodeKeyOf,
} from "../../src/flow/index.js";

function manifestOf(root: WorkflowManifest["root"], id = "wf"): WorkflowManifest {
  return { kind: "workflow", workflowSchemaVersion: 1, id, root };
}

function fakeHost(handlers: {
  agent?: (effect: HostEffect) => unknown | Promise<unknown>;
  tool?: (effect: HostEffect) => unknown | Promise<unknown>;
  fn?: (effect: HostEffect) => unknown;
  verify?: (effect: HostEffect) => unknown;
  pendingOnce?: (effect: HostEffect) => boolean;
}): {
  host: DurableHost;
  journal: Map<string, EffectResolution>;
  seen: HostEffect[];
} {
  const journal = new Map<string, EffectResolution>();
  const seen: HostEffect[] = [];
  const pendingHit = new Set<string>();

  const host: DurableHost = {
    async resolveEffect(effect) {
      seen.push(effect);
      const recorded = journal.get(effect.effectId);
      if (recorded) return recorded;

      if (handlers.pendingOnce?.(effect) && !pendingHit.has(effect.effectId)) {
        pendingHit.add(effect.effectId);
        const pending = { status: "pending" as const };
        journal.set(effect.effectId, pending);
        return pending;
      }

      let value: unknown;
      try {
        if (effect.kind === "agent") value = await handlers.agent?.(effect);
        else if (effect.kind === "tool") value = await handlers.tool?.(effect);
        else if (effect.kind === "fn") value = handlers.fn?.(effect);
        else if (effect.kind === "verify") value = handlers.verify?.(effect);
        else throw new Error(`unexpected ${effect.kind}`);
      } catch (error) {
        value = {
          kind: "failed",
          code: effect.kind === "verify" ? "loop.verify-failed" : "fn.failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (value === undefined) {
        value = {
          kind: "failed",
          code: "fn.failed",
          message: `no handler for ${effect.kind} @ ${effect.path}`,
        };
      }
      const resolution: EffectResolution = {
        status: "completed",
        outcome: { value },
      };
      journal.set(effect.effectId, resolution);
      return resolution;
    },
  };
  return { host, journal, seen };
}

describe("flow paths / keys / iterations", () => {
  it("joins paths, drops Map indices for keys, formats effect ids (WF-R16,R18,R19,R41)", () => {
    expect(joinPath("report", "analyst")).toBe("report/analyst");
    expect(mapItemPath("implement", 2, "code")).toBe("implement[2]/code");
    expect(nodeKeyOf("implement[2]/code/coder")).toBe("implement/code/coder");
    expect(iterationsOf([])).toBe("-");
    expect(iterationsOf([3])).toBe("3");
    expect(iterationsOf([2, 1])).toBe("2.1");
    expect(
      flowEffectId({
        turnId: "t",
        segment: 0,
        path: "implement[2]/code",
        kind: "agent",
        iterations: "1",
      }),
    ).toBe("t:0:flow:implement[2]/code:agent:1");
    expect(
      flowEffectId({
        turnId: "t",
        segment: 0,
        path: "report/loud",
        kind: "fn",
        iterations: "-",
        role: "slot-input",
      }),
    ).toBe("t:0:flow:report/loud:fn.slot-input:-");
  });
});

describe("flow Chain", () => {
  it("pipes outputs and exposes results to slot input (CHAIN-R1–R3,R6–R8,A2)", async () => {
    const manifest = manifestOf({
      chain: {
        id: "report",
        steps: [
          { agent: "researcher" },
          { slot: { input: { fn: true }, run: { agent: "analyst" } } },
          { tool: { name: "publish" } },
        ],
      },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: { topic: "AI" },
    });
    const { host, seen, journal } = fakeHost({
      agent: (e) => {
        const body = e.input as { agentId: string; input: unknown };
        if (body.agentId === "researcher") return "findings";
        return `analysis:${body.input}`;
      },
      fn: (e) => {
        const args = e.input as {
          value: unknown;
          input: { topic: string };
          results: Record<string, unknown>;
        };
        expect(args.results.researcher).toBe("findings");
        expect(args.input.topic).toBe("AI");
        expect(args.value).toBe("findings");
        return `shaped:${args.input.topic}:${args.value}`;
      },
      tool: (e) => `published:${e.input}`,
    });

    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result).toEqual({
      status: "completed",
      output: "published:analysis:shaped:AI:findings",
    });
    expect(seen.map((e) => `${e.kind}:${e.path}`)).toEqual([
      "agent:report/researcher",
      "fn:report/analyst",
      "agent:report/analyst",
      "tool:report/publish",
    ]);
    expect(seen.every((e) => e.iterations === "-")).toBe(true);

    const again = await runFlowDurable({ manifest, checkpoint, host });
    expect(again).toEqual(result);
    expect(journal.size).toBe(4);
  });

  it("fails with the step path and never starts later steps (CHAIN-E1,A4)", async () => {
    const manifest = manifestOf({
      chain: { id: "pipe", steps: [{ agent: "a" }, { agent: "b" }] },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: "x",
    });
    const { host, seen } = fakeHost({
      agent: (e) =>
        (e.input as { agentId: string }).agentId === "a"
          ? { kind: "failed", code: "agent.failed", message: "boom" }
          : "never",
    });
    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        error: { code: "agent.failed", message: "boom", path: "pipe/a" },
      },
    });
    expect(seen.some((e) => e.path === "pipe/b")).toBe(false);
  });
});

describe("flow Switch", () => {
  it("runs the matching case only (SWITCH-R1–R3,R8,A5)", async () => {
    const manifest = manifestOf({
      switch: {
        id: "route",
        on: { fn: true },
        cases: {
          bug: { agent: "bug-fixer" },
          billing: { agent: "billing" },
        },
        default: { agent: "general" },
      },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: { kind: "billing" },
    });
    const { host, seen } = fakeHost({
      fn: (e) => (e.input as { kind: string }).kind,
      agent: (e) => `ran:${(e.input as { agentId: string }).agentId}`,
    });
    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result).toMatchObject({
      status: "completed",
      result: { status: "completed", output: "ran:billing" },
    });
    expect(seen.map((e) => e.path)).toEqual(["route", "route/billing"]);
    expect(seen.some((e) => e.path?.includes("bug"))).toBe(false);
  });

  it("switch.no-match without default; default path when present (SWITCH-E1,A3)", async () => {
    const noDefault = manifestOf({
      switch: { id: "route", on: { fn: true }, cases: { a: { agent: "a" } } },
    });
    const r1 = await runFlowDurable({
      manifest: noDefault,
      checkpoint: createFlowCheckpoint({
        manifest: noDefault,
        sessionId: "s1",
        turnId: "t1",
        input: "z",
      }),
      host: fakeHost({ fn: () => "z", agent: () => "x" }).host,
    });
    expect(r1.status).toBe("failed");
    if (r1.status !== "failed") throw new Error("expected failed");
    expect(r1.result).toMatchObject({
      status: "failed",
      error: { code: "switch.no-match", path: "route" },
    });
    expect(r1.result.status === "failed" && r1.result.error.message).toContain("z");

    const withDefault = manifestOf({
      switch: {
        id: "route",
        on: { fn: true },
        cases: { a: { agent: "a" } },
        default: { agent: "general" },
      },
    });
    const h2 = fakeHost({
      fn: () => "z",
      agent: (e) => (e.input as { agentId: string }).agentId,
    });
    const r2 = await runFlowDurable({
      manifest: withDefault,
      checkpoint: createFlowCheckpoint({
        manifest: withDefault,
        sessionId: "s1",
        turnId: "t2",
        input: "z",
      }),
      host: h2.host,
    });
    expect(r2).toMatchObject({
      status: "completed",
      result: { status: "completed", output: "general" },
    });
    expect(h2.seen.some((e) => e.path === "route/default")).toBe(true);
  });

  it("fails fn.failed when on returns a non-string (SWITCH-R4,E2)", async () => {
    const manifest = manifestOf({
      switch: { id: "route", on: { fn: true }, cases: { a: { agent: "a" } } },
    });
    const result = await runFlowDurable({
      manifest,
      checkpoint: createFlowCheckpoint({
        manifest,
        sessionId: "s1",
        turnId: "t1",
        input: 1,
      }),
      host: fakeHost({ fn: () => 42, agent: () => "x" }).host,
    });
    expect(result).toMatchObject({
      status: "failed",
      result: { status: "failed", error: { code: "fn.failed", path: "route" } },
    });
  });

  it("replays journaled on after crash before case starts (SWITCH-A1,A2)", async () => {
    const manifest = manifestOf({
      switch: {
        id: "route",
        on: { fn: true },
        cases: { bug: { agent: "bug" }, other: { agent: "other" } },
      },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: { kind: "bug" },
    });
    let onCalls = 0;
    const { host, journal } = fakeHost({
      fn: () => {
        onCalls += 1;
        return "bug";
      },
      agent: () => "fixed",
      pendingOnce: (e) => e.kind === "agent",
    });

    const first = await runFlowDurable({ manifest, checkpoint, host });
    expect(first.status).toBe("waiting");
    expect(onCalls).toBe(1);

    // Code change to on would not matter: journal already has the key.
    const agentId = [...journal.keys()].find((id) => id.includes(":agent:"));
    expect(agentId).toBeTruthy();
    journal.set(agentId!, { status: "completed", outcome: { value: "fixed" } });

    const second = await runFlowDurable({ manifest, checkpoint, host });
    expect(second).toMatchObject({
      status: "completed",
      result: { status: "completed", output: "fixed" },
    });
    expect(onCalls).toBe(1);
  });
});

describe("flow Parallel", () => {
  it("returns object in declaration order and waits with all effects (PAR-R1,R3,R8,A5)", async () => {
    const manifest = manifestOf({
      parallel: {
        id: "review",
        branches: {
          security: { agent: "sec" },
          style: { agent: "style" },
          tests: { agent: "tests" },
        },
      },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: "pr",
    });
    const { host, seen } = fakeHost({
      agent: (e) => (e.input as { agentId: string }).agentId,
    });
    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        output: { security: "sec", style: "style", tests: "tests" },
      },
    });
    expect(Object.keys((result as { result: { output: object } }).result.output)).toEqual([
      "security",
      "style",
      "tests",
    ]);
    expect(seen.map((e) => e.path).sort()).toEqual([
      "review/security",
      "review/style",
      "review/tests",
    ]);
  });

  it("fail-fast: first branch failure fails Parallel while siblings pending (PAR-R4,E1,A2,D2,WF-E15)", async () => {
    const manifest = manifestOf({
      parallel: {
        id: "review",
        branches: {
          security: { agent: "sec" },
          style: { agent: "style" },
          tests: { agent: "tests" },
        },
      },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: "pr",
    });
    const { host, journal, seen } = fakeHost({
      agent: (e) => {
        const id = (e.input as { agentId: string }).agentId;
        if (id === "style") return { kind: "failed", code: "agent.failed", message: "lint" };
        return "ok";
      },
      pendingOnce: (e) => (e.input as { agentId?: string })?.agentId === "tests",
    });

    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.result).toMatchObject({
      status: "failed",
      error: { code: "agent.failed", message: "lint", path: "review/style" },
    });
    // tests was offered (pending) but Parallel did not wait for it to complete
    expect(seen.some((e) => e.path === "review/tests")).toBe(true);
    expect(journal.get(seen.find((e) => e.path === "review/tests")!.effectId)?.status).toBe(
      "pending",
    );
    expect(result.cancelEffectIds).toContain(seen.find((e) => e.path === "review/tests")!.effectId);
  });
});

describe("flow Map", () => {
  it("maps items concurrently with indexed paths and array output (MAP-R1,R2,R4,R10,R11)", async () => {
    const manifest = manifestOf({
      map: {
        id: "write",
        over: { fn: true },
        each: { agent: "section-writer" },
      },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: { sections: ["a", "b", "c"] },
    });
    const { host, seen } = fakeHost({
      fn: (e) => (e.input as { sections: string[] }).sections,
      agent: (e) => {
        expect(nodeKeyOf(e.path!)).toBe("write/section-writer");
        return `out:${(e.input as { input: string }).input}`;
      },
    });
    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result).toMatchObject({
      status: "completed",
      result: { status: "completed", output: ["out:a", "out:b", "out:c"] },
    });
    expect(seen.filter((e) => e.kind === "agent").map((e) => e.path)).toEqual([
      "write[0]/section-writer",
      "write[1]/section-writer",
      "write[2]/section-writer",
    ]);
  });

  it("empty over returns [] with no item effects (MAP-R5,A2)", async () => {
    const manifest = manifestOf({
      map: { id: "write", over: { fn: true }, each: { agent: "w" } },
    });
    const { host, seen } = fakeHost({
      fn: () => [],
      agent: () => "x",
    });
    const result = await runFlowDurable({
      manifest,
      checkpoint: createFlowCheckpoint({
        manifest,
        sessionId: "s1",
        turnId: "t1",
        input: {},
      }),
      host,
    });
    expect(result).toMatchObject({
      status: "completed",
      result: { status: "completed", output: [] },
    });
    expect(seen.filter((e) => e.kind === "agent")).toHaveLength(0);
  });

  it("map.not-a-list when over is not an array (MAP-E1,WF-E8)", async () => {
    const manifest = manifestOf({
      map: { id: "write", over: { fn: true }, each: { agent: "w" } },
    });
    const result = await runFlowDurable({
      manifest,
      checkpoint: createFlowCheckpoint({
        manifest,
        sessionId: "s1",
        turnId: "t1",
        input: {},
      }),
      host: fakeHost({ fn: () => ({ nope: true }), agent: () => "x" }).host,
    });
    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        error: { code: "map.not-a-list", path: "write" },
      },
    });
  });

  it("map.too-many-items before any item starts (MAP-E2,MAP-A3,WF-E9,WF-L2)", async () => {
    const manifest = manifestOf({
      map: { id: "write", over: { fn: true }, each: { agent: "w" } },
    });
    const { host, seen } = fakeHost({
      fn: () => [0, 1, 2],
      agent: () => "x",
    });
    const result = await runFlowDurable({
      manifest,
      checkpoint: createFlowCheckpoint({
        manifest,
        sessionId: "s1",
        turnId: "t1",
        input: {},
      }),
      host,
      limits: { maxMapItems: 2 },
    });
    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        error: { code: "map.too-many-items", path: "write" },
      },
    });
    expect(seen.filter((e) => e.kind === "agent")).toHaveLength(0);
    expect(seen.filter((e) => e.kind === "fn")).toHaveLength(1);
  });

  it("fail-fast cancels siblings; error path includes index (MAP-R6,E4,A4,D3)", async () => {
    const manifest = manifestOf({
      map: { id: "write", over: { fn: true }, each: { agent: "w" } },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: [0, 1, 2],
    });
    const { host, journal, seen } = fakeHost({
      fn: (e) => e.input,
      agent: (e) => {
        const item = (e.input as { input: number }).input;
        if (item === 1) return { kind: "failed", code: "agent.failed", message: "bad" };
        return `ok:${item}`;
      },
      pendingOnce: (e) => (e.input as { input?: number })?.input === 2,
    });
    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.result).toMatchObject({
      status: "failed",
      error: { code: "agent.failed", path: "write[1]/w" },
    });
    const pending = seen.find((e) => e.path === "write[2]/w");
    expect(pending).toBeTruthy();
    expect(journal.get(pending!.effectId)?.status).toBe("pending");
    expect(result.cancelEffectIds).toContain(pending!.effectId);
  });

  it("replays journaled over list after partial progress (MAP-R12,A1)", async () => {
    const manifest = manifestOf({
      map: { id: "write", over: { fn: true }, each: { agent: "w" } },
    });
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "s1",
      turnId: "t1",
      input: { sections: ["a", "b"] },
    });
    let overCalls = 0;
    const { host, journal } = fakeHost({
      fn: () => {
        overCalls += 1;
        return ["a", "b"];
      },
      agent: (e) => `out:${(e.input as { input: string }).input}`,
      pendingOnce: (e) => e.path === "write[1]/w",
    });
    const first = await runFlowDurable({ manifest, checkpoint, host });
    expect(first.status).toBe("waiting");
    expect(overCalls).toBe(1);

    const pendingId = [...journal.entries()].find(([, v]) => v.status === "pending")?.[0];
    journal.set(pendingId!, {
      status: "completed",
      outcome: { value: "out:b" },
    });
    const second = await runFlowDurable({ manifest, checkpoint, host });
    expect(second).toMatchObject({
      status: "completed",
      result: { status: "completed", output: ["out:a", "out:b"] },
    });
    expect(overCalls).toBe(1);
  });
});

describe("flow Loop extras (verify / decide errors)", () => {
  it("maps verify failure to loop.verify-failed (LOOP-R7,WF-E12)", async () => {
    const manifest = manifestOf({
      loop: {
        id: "polish",
        run: { agent: "writer" },
        verify: { fn: true },
        decide: { fn: true },
      },
    });
    const result = await runFlowDurable({
      manifest,
      checkpoint: createFlowCheckpoint({
        manifest,
        sessionId: "s1",
        turnId: "t1",
        input: "draft",
      }),
      host: fakeHost({
        agent: () => "text",
        verify: () => {
          throw new Error("harness exploded");
        },
        fn: () => ({ output: "nope" }),
      }).host,
    });
    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        error: { code: "loop.verify-failed", path: "polish" },
      },
    });
  });

  it("maps decide fn.failed to loop.stopped (WF-E10,LOOP-R11)", async () => {
    const manifest = manifestOf({
      loop: {
        id: "polish",
        run: { agent: "writer" },
        verify: { fn: true },
        decide: { fn: true },
      },
    });
    const result = await runFlowDurable({
      manifest,
      checkpoint: createFlowCheckpoint({
        manifest,
        sessionId: "s1",
        turnId: "t1",
        input: "draft",
      }),
      host: fakeHost({
        agent: () => "text",
        verify: () => ({ pass: true }),
        fn: () => {
          throw new Error("giving up");
        },
      }).host,
    });
    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        error: { code: "loop.stopped", message: "giving up", path: "polish" },
      },
    });
  });

  it("passes { task, response, iteration } to verifier agents (LOOP-R5,D6)", async () => {
    const manifest = manifestOf({
      loop: {
        id: "essay",
        run: { agent: "writer" },
        verify: { agent: "judge" },
        decide: { fn: true },
      },
    });
    const { host, seen } = fakeHost({
      agent: (e) => {
        const body = e.input as { agentId: string; input: unknown };
        if (body.agentId === "writer") return "draft-text";
        expect(body.input).toEqual({
          task: "prompt",
          response: "draft-text",
          iteration: 1,
        });
        return { pass: true };
      },
      fn: (e) => {
        const args = e.input as { output: string; verdict: { pass: boolean } };
        expect(args.verdict.pass).toBe(true);
        return { output: args.output };
      },
    });
    const result = await runFlowDurable({
      manifest,
      checkpoint: createFlowCheckpoint({
        manifest,
        sessionId: "s1",
        turnId: "t1",
        input: "prompt",
      }),
      host,
    });
    expect(result).toMatchObject({
      status: "completed",
      result: { status: "completed", output: "draft-text" },
    });
    expect(seen.some((e) => e.path === "essay/judge" && e.kind === "agent")).toBe(true);
  });
});

describe("flow values (WF-R14)", () => {
  it("Parallel returns an object and Map returns an array; leaves pass through", async () => {
    const parallel = manifestOf({
      parallel: { id: "p", branches: { a: { agent: "a" } } },
    });
    const map = manifestOf({
      map: { id: "m", over: { fn: true }, each: { agent: "a" } },
    });
    const p = await runFlowDurable({
      manifest: parallel,
      checkpoint: createFlowCheckpoint({
        manifest: parallel,
        sessionId: "s",
        turnId: "t",
        input: 1,
      }),
      host: fakeHost({ agent: () => 7 }).host,
    });
    const m = await runFlowDurable({
      manifest: map,
      checkpoint: createFlowCheckpoint({
        manifest: map,
        sessionId: "s",
        turnId: "t",
        input: [1],
      }),
      host: fakeHost({
        fn: (e) => e.input,
        agent: (e) => (e.input as { input: number }).input + 1,
      }).host,
    });
    expect(p).toMatchObject({
      status: "completed",
      result: { output: { a: 7 } },
    });
    expect(m).toMatchObject({
      status: "completed",
      result: { output: [2] },
    });
  });
});

/**
 * Keys the engine sends must be keys core registers: resolve every fn, verify and tool
 * effect through `getBinding().nodes[effect.key]`, the way the Action endpoint does.
 */
describe("flow effect keys match core bindings", () => {
  const Verdict = z.discriminatedUnion("pass", [
    z.object({ pass: z.literal(true) }),
    z.object({ pass: z.literal(false), feedback: z.string() }),
  ]);
  const split = tool({
    name: "split",
    input: z.object({ text: z.string() }),
    output: z.object({ words: z.array(z.string()) }),
    run: async ({ text }) => ({ words: text.split(" ") }),
  });
  const shout = tool({
    name: "shout",
    input: z.object({ word: z.string() }),
    output: z.object({ loud: z.string() }),
    run: async ({ word }) => ({ loud: word.toUpperCase() }),
  });
  const words = (value: unknown) => (value as { words: string[] }).words.map((word) => ({ word }));

  async function runBound(
    workflow: BuiltWorkflow,
    input: JsonValue,
    agent: (agentId: string, input: unknown) => unknown = () => "agent-output",
  ) {
    const { nodes } = workflow.getBinding();
    const seen: HostEffect[] = [];
    const journal = new Map<string, EffectResolution>();
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        seen.push(effect);
        let value: unknown;
        if (effect.kind === "agent") {
          const body = effect.input as { agentId: string; input: unknown };
          value = agent(body.agentId, body.input);
        } else {
          const impl = nodes[effect.key];
          const expected = effect.kind === "tool" ? "tool" : effect.kind;
          if (!impl || impl.kind !== expected)
            throw new Error(`No ${effect.kind} binding for key '${effect.key}'`);
          value =
            impl.kind === "tool"
              ? await impl.tool.execute(effect.input, {} as never)
              : await impl.fn(effect.input as never);
        }
        const resolution: EffectResolution = {
          status: "completed",
          outcome: { value: value as JsonValue },
        };
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };
    const result = await runFlowDurable({
      manifest: workflow.manifest,
      checkpoint: createFlowCheckpoint({
        manifest: workflow.manifest,
        sessionId: "s1",
        turnId: "t1",
        input,
      }),
      host,
    });
    return { result, seen };
  }

  it("routes a slot input and a Map over", async () => {
    const workflow = Chain({
      id: "shouter",
      steps: [
        { run: split, input: ({ value }) => ({ text: String(value) }) },
        MapNode({ id: "each", over: words, each: shout }),
      ],
    });
    const { result, seen } = await runBound(workflow, "hello big world");
    expect(result).toMatchObject({
      status: "completed",
      result: { output: [{ loud: "HELLO" }, { loud: "BIG" }, { loud: "WORLD" }] },
    });
    expect(seen.filter((e) => e.kind === "fn").map((e) => e.key)).toEqual([
      "shouter/split/input",
      "shouter/each/over",
    ]);
  });

  it("gives a slot input and the Map it wraps distinct effects", async () => {
    const workflow = Chain({
      id: "wrapped",
      steps: [
        { run: split, input: ({ value }) => ({ text: String(value) }) },
        {
          id: "loud",
          run: MapNode({ id: "each", over: words, each: shout }),
          input: ({ value }) => ({ words: (value as { words: string[] }).words.slice(0, 2) }),
        },
      ],
    });
    const { result, seen } = await runBound(workflow, "one two three");
    expect(result).toMatchObject({
      status: "completed",
      result: { output: [{ loud: "ONE" }, { loud: "TWO" }] },
    });
    const onPath = seen.filter((e) => e.kind === "fn" && e.path === "wrapped/loud");
    expect(onPath.map((e) => e.key)).toEqual(["wrapped/loud/input", "wrapped/loud/over"]);
    expect(new Set(onPath.map((e) => e.effectId)).size).toBe(2);
  });

  it("gives a slot input and the Switch it wraps distinct effects", async () => {
    const workflow = Chain({
      id: "wrapped",
      steps: [
        {
          id: "route",
          run: Switch({
            id: "pick",
            on: (value) => ((value as { word: string }).word.length > 3 ? "long" : "short"),
            cases: { long: shout, short: shout },
          }),
          input: ({ value }) => ({ word: String(value) }),
        },
      ],
    });
    const { result, seen } = await runBound(workflow, "hello");
    expect(result).toMatchObject({ status: "completed", result: { output: { loud: "HELLO" } } });
    expect(seen.filter((e) => e.kind === "fn").map((e) => e.key)).toEqual([
      "wrapped/route/input",
      "wrapped/route/on",
    ]);
  });

  it("routes a per-item slot input inside a Map", async () => {
    const workflow = MapNode({
      id: "each",
      over: (value) => value as string[],
      each: { run: shout, input: ({ value, index }) => ({ word: `${index}:${String(value)}` }) },
    });
    const { result, seen } = await runBound(workflow, ["a", "b"]);
    expect(result).toMatchObject({
      status: "completed",
      result: { output: [{ loud: "0:A" }, { loud: "1:B" }] },
    });
    expect(new Set(seen.filter((e) => e.kind === "fn").map((e) => e.key))).toEqual(
      new Set(["each/over", "each/shout/input"]),
    );
  });

  it("routes a verifier slot input, verify function and decide in Loops", async () => {
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const judge = Agent({ id: "judge", instructions: "Judge.", outputSchema: Verdict }).build();
    const judged = Loop({
      id: "essay",
      run: writer,
      verify: { run: judge, input: ({ value }) => ({ draft: value }) },
      decide: ({ verdict, output }) => (verdict.pass ? { output } : { input: "again" }),
    });
    const first = await runBound(judged, "prompt", (agentId, input) => {
      if (agentId === "writer") return "draft-text";
      expect(input).toEqual({ draft: { task: "prompt", response: "draft-text", iteration: 1 } });
      return { pass: true };
    });
    expect(first.result).toMatchObject({ status: "completed", result: { output: "draft-text" } });
    expect(first.seen.filter((e) => e.kind === "fn").map((e) => e.key)).toEqual([
      "essay/judge/input",
      "essay/decide",
    ]);

    const checked = Loop({
      id: "polish",
      run: writer,
      verify: ({ output }) => (output ? { pass: true } : { pass: false, feedback: "empty" }),
      decide: ({ output }) => ({ output }),
    });
    const second = await runBound(checked, "prompt");
    expect(second.result).toMatchObject({
      status: "completed",
      result: { output: "agent-output" },
    });
    expect(second.seen.filter((e) => e.kind !== "agent").map((e) => `${e.kind}:${e.key}`)).toEqual([
      "verify:polish",
      "fn:polish/decide",
    ]);
  });
});
