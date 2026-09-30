import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  embeddedAgent,
  flow,
  tool,
  VerdictSchema,
  withInstructions,
  type AgentManifest,
  type JsonValue,
  type WorkflowManifestV2,
} from "@nylorun/core/define";
import {
  agentTurnValue,
  createFlowCheckpoint,
  runFlowDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../../src/run/index.js";

/**
 * Flow Agents Phase 2, end to end: flow agents compile to workflow manifest v2 and run
 * on the `flow-2` engine. Leaf agents resolve from the embedded `agents`; every fn,
 * verify and tool effect resolves through the flow's own bindings, as the Action endpoint does.
 * Case ids (S1, W1, …) are the design's primitive test cases.
 */

type Built = {
  readonly manifest: WorkflowManifestV2;
  getBinding(): {
    nodes: Record<
      string,
      {
        kind: string;
        fn?: (args: never) => unknown;
        tool?: { execute(i: unknown, c: never): Promise<unknown> };
      }
    >;
  };
};

type AgentCall = { agentId: string; input: unknown; path: string; effect: HostEffect };

async function run(
  workflow: unknown,
  input: JsonValue,
  agents: (call: AgentCall) => unknown = ({ agentId }) => `${agentId} out`,
) {
  const built = workflow as Built;
  const { nodes } = built.getBinding();
  const seen: HostEffect[] = [];
  const journal = new Map<string, EffectResolution>();
  const host: DurableHost = {
    async resolveEffect(effect) {
      const recorded = journal.get(effect.effectId);
      if (recorded) return recorded;
      seen.push(effect);
      let value: unknown;
      try {
        if (effect.kind === "agent") {
          const body = effect.input as {
            agentId: string;
            input: unknown;
            path: string;
            flow?: string[];
          };
          const leaf = embeddedAgent(built.manifest, body.flow ?? [], body.agentId);
          if (!leaf || "kind" in leaf) throw new Error(`No embedded agent '${body.agentId}'`);
          value = agents({ ...body, effect });
        } else {
          const impl = nodes[effect.key];
          if (!impl || impl.kind !== effect.kind)
            throw new Error(`No ${effect.kind} binding for key '${effect.key}'`);
          value =
            impl.kind === "tool"
              ? { kind: "completed", output: await impl.tool!.execute(effect.input, {} as never) }
              : await impl.fn!(effect.input as never);
        }
      } catch (error) {
        value = {
          kind: "failed",
          code: effect.kind === "verify" ? "loop.verify-failed" : "fn.failed",
          message: String((error as Error).message),
        };
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
    manifest: built.manifest,
    checkpoint: createFlowCheckpoint({
      manifest: built.manifest,
      sessionId: "s1",
      turnId: "t1",
      input,
    }),
    host,
  });
  return { result, seen };
}

const agentPaths = (seen: HostEffect[]) =>
  seen.filter((e) => e.kind === "agent").map((e) => e.path);
const keys = (seen: HostEffect[]) => seen.filter((e) => e.kind !== "agent").map((e) => e.key);
const output = (value: Awaited<ReturnType<typeof run>>) =>
  (value.result as { result?: { output?: unknown } }).result?.output;
const failure = (value: Awaited<ReturnType<typeof run>>) =>
  (value.result as { result?: { error?: { code: string; message: string; path?: string } } }).result
    ?.error;

const agent = (id: string) => Agent({ id }).instructions(`Be ${id}.`);
const Review = z.object({ score: z.number() });
const triage = agent("triage").output(
  z.object({ kind: z.enum(["bug", "docs", "feature"]), summary: z.string() }),
);
const planner = agent("planner").output(z.object({ tasks: z.array(z.string()) }));
const tester = agent("tester").output(VerdictSchema);
const docsWriter = agent("docs-writer");
const openPr = tool({
  name: "open_pr",
  input: z.object({ title: z.string() }),
  output: z.object({ url: z.string() }),
  async run({ title }) {
    return { url: `https://example.com/pr/${encodeURIComponent(title)}` };
  },
});

const issueDesk = Agent({ id: "issue-desk" })
  .step(triage)
  .switch(
    {
      bug: flow().loop(agent("fixer"), { verify: tester, max: 3 }),
      docs: docsWriter,
      default: flow()
        .step(planner)
        .map(agent("implementer"), { input: ({ input }) => input.tasks })
        .step(docsWriter, { id: "feature-docs" }),
    },
    { on: ({ input }) => input.kind, id: "route" },
  )
  .parallel(
    {
      security: agent("security-reviewer").output(Review),
      style: agent("style-reviewer").output(Review),
    },
    { id: "reviews" },
  )
  .step(openPr, {
    input: ({ results, flowInput }) => ({
      title: `${results.triage.summary} #${(flowInput as { issue: number }).issue} ${results.reviews.security.score}/${results.reviews.style.score}`,
    }),
  });

function desk(kind: "bug" | "docs" | "feature", failures = 1) {
  let attempts = 0;
  return ({ agentId, input }: AgentCall): unknown => {
    switch (agentId) {
      case "triage":
        return { kind, summary: `fix ${kind}` };
      case "fixer":
        attempts += 1;
        return `patch ${attempts} for ${JSON.stringify(input)}`;
      case "tester":
        return attempts > failures
          ? { pass: true }
          : { pass: false, feedback: `attempt ${attempts} fails` };
      case "planner":
        return { tasks: ["api", "ui"] };
      case "implementer":
        return `done ${String(input)}`;
      case "docs-writer":
        return "docs updated";
      case "security-reviewer":
        return { score: 4 };
      case "style-reviewer":
        return { score: 5 };
      default:
        throw new Error(`unexpected agent ${agentId}`);
    }
  };
}

describe("issue-desk on flow-2", () => {
  it("names sessions by leaf: control stages add nothing, a Map item adds [i]", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 7 }, desk("feature"));
    expect(output(run1)).toEqual({ url: "https://example.com/pr/fix%20feature%20%237%204%2F5" });
    expect(agentPaths(run1.seen)).toEqual([
      "triage",
      "planner",
      "implementer[0]",
      "implementer[1]",
      "feature-docs",
      "security-reviewer",
      "style-reviewer",
    ]);
    expect(keys(run1.seen)).toEqual(["route:on", "@1.default.1:input", "open_pr:input", "open_pr"]);
    expect(run1.result.checkpoint.engineVersion).toBe("flow-2");
  });

  it("routes docs straight to the docs writer (W1)", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 9 }, desk("docs"));
    expect(agentPaths(run1.seen)).toContain("docs-writer");
    expect(output(run1)).toMatchObject({ url: expect.any(String) });
  });

  it("retries the loop body in the same session with the verifier's feedback (L1)", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 8 }, desk("bug", 1));
    expect(output(run1)).toMatchObject({ url: expect.any(String) });
    const fixer = run1.seen.filter((e) => e.kind === "agent" && e.path === "fixer");
    expect(fixer.map((e) => (e.input as { input: unknown }).input)).toEqual([
      { kind: "bug", summary: "fix bug" },
      "attempt 1 fails",
    ]);
    expect(fixer.map((e) => e.iterations)).toEqual(["1", "2"]);
    const judge = run1.seen.filter((e) => e.kind === "agent" && e.path === "tester");
    expect(judge.map((e) => e.context)).toEqual([
      { loopPath: "@1.bug", n: 1, role: "verify-agent" },
      { loopPath: "@1.bug", n: 2, role: "verify-agent" },
    ]);
  });

  it("ends the run with loop.exhausted after max failed attempts", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 1 }, desk("bug", 99));
    expect(run1.result.status).toBe("failed");
    expect(failure(run1)).toMatchObject({ code: "loop.exhausted", path: "@1.bug" });
    expect(failure(run1)!.message).toBe("Loop stopped after 3 attempts: attempt 3 fails");
  });
});

describe("step", () => {
  it("S1/S3: an agent's output feeds the next stage; input reshapes it", async () => {
    const flowAgent = Agent({ id: "f" })
      .step(triage)
      .step(openPr, { input: ({ input }) => ({ title: input.summary }) });
    const run1 = await run(flowAgent, "x", () => ({ kind: "bug", summary: "s" }));
    expect(output(run1)).toEqual({ url: "https://example.com/pr/s" });
    const title = run1.seen.find((e) => e.key === "open_pr:input")!;
    expect(title.input).toEqual({
      input: { kind: "bug", summary: "s" },
      results: { triage: { kind: "bug", summary: "s" } },
      flowInput: "x",
    });
    expect(title.path).toBe("open_pr:input");
  });

  it("S5: a reused agent gets a session per id", async () => {
    const writer = agent("writer");
    const run1 = await run(
      Agent({ id: "f" }).step(writer).step(writer, { id: "final-writer" }),
      "x",
    );
    expect(agentPaths(run1.seen)).toEqual(["writer", "final-writer"]);
    expect(run1.seen.map((e) => (e.input as { agentId: string }).agentId)).toEqual([
      "writer",
      "writer",
    ]);
  });

  it("S6: an anonymous sequence is inlined; results see its steps", async () => {
    const f = Agent({ id: "f" })
      .step(flow().step(agent("a")).step(agent("b")))
      .step(openPr, { input: ({ results }) => ({ title: `${results.a}+${results.b}` }) });
    expect(output(await run(f, "x"))).toEqual({ url: "https://example.com/pr/a%20out%2Bb%20out" });
  });

  it("S7: a nested flow agent's leaves run under its id, with its own flowInput", async () => {
    const review = Agent({ id: "review" })
      .step(agent("reader"))
      .step(openPr, { input: ({ flowInput }) => ({ title: String(flowInput) }) });
    const outer = Agent({ id: "outer" }).step(agent("writer")).step(review);
    const run1 = await run(outer, "task");
    expect(agentPaths(run1.seen)).toEqual(["writer", "review/reader"]);
    expect(keys(run1.seen)).toEqual(["review/open_pr:input", "review/open_pr"]);
    expect(output(run1)).toEqual({ url: "https://example.com/pr/writer%20out" });
    expect(run1.seen[1]!.input).toMatchObject({ agentId: "reader", flow: ["review"] });
  });
});

describe("switch", () => {
  it("W2: no default and an unknown key fails, naming the key", async () => {
    const f = Agent({ id: "f" }).switch({ bug: agent("fixer") }, { on: () => "other" as never });
    const run1 = await run(f, "x");
    expect(failure(run1)).toMatchObject({ code: "switch.no-match", path: "@0" });
    expect(failure(run1)!.message).toContain('"other"');
  });

  it("W3: a case that is a sequence names its leaves directly", async () => {
    const runTests = tool({
      name: "run_tests",
      input: z.object({}),
      async run() {
        return "green";
      },
    });
    const f = Agent({ id: "f" }).switch(
      { bug: flow().step(agent("fixer")).step(runTests) },
      { on: () => "bug" },
    );
    const run1 = await run(f, "x");
    expect(run1.seen.map((e) => e.path)).toEqual(["@0:on", "fixer", "run_tests"]);
    expect(output(run1)).toBe("green");
  });

  it("on sees results and flowInput at any stage", async () => {
    const f = Agent({ id: "f" })
      .step(triage)
      .switch(
        { a: agent("a"), b: agent("b") },
        {
          on: ({ results, flowInput }) =>
            results.triage.kind === "bug" && flowInput === "go" ? "b" : "a",
        },
      );
    const run1 = await run(f, "go", ({ agentId }) =>
      agentId === "triage" ? { kind: "bug", summary: "" } : agentId,
    );
    expect(output(run1)).toBe("b");
  });
});

describe("parallel", () => {
  it("P1: output is keyed by branch and readable as results.<id>", async () => {
    const f = Agent({ id: "f" })
      .parallel({ security: agent("sec"), style: agent("sty") }, { id: "reviews" })
      .step(openPr, {
        input: ({ results }) => ({ title: `${results.reviews.security}|${results.reviews.style}` }),
      });
    const run1 = await run(f, "x");
    expect(agentPaths(run1.seen)).toEqual(["sec", "sty"]);
    expect(output(run1)).toEqual({ url: "https://example.com/pr/sec%20out%7Csty%20out" });
  });

  it("P3: one failing branch fails the stage with the leaf's path", async () => {
    const f = Agent({ id: "f" }).parallel({ a: agent("a"), b: agent("b") });
    const run1 = await run(f, "x", ({ agentId }) =>
      agentId === "b" ? { kind: "failed", code: "agent.failed", message: "b broke" } : "ok",
    );
    expect(failure(run1)).toMatchObject({ code: "agent.failed", path: "b" });
  });
});

describe("map", () => {
  it("M1/M5: runs over its input, one session per item, output in item order", async () => {
    const splitter = agent("splitter").output(z.array(z.string()));
    const f = Agent({ id: "f" }).step(splitter).map(agent("writer"));
    const run1 = await run(f, "x", ({ agentId, input }) =>
      agentId === "splitter" ? ["a", "b", "c"] : `w:${String(input)}`,
    );
    expect(agentPaths(run1.seen)).toEqual(["splitter", "writer[0]", "writer[1]", "writer[2]"]);
    expect(output(run1)).toEqual(["w:a", "w:b", "w:c"]);
  });

  it("M2: an empty list opens no sessions", async () => {
    const f = Agent({ id: "f" }).map(agent("writer"), { input: () => [] });
    const run1 = await run(f, "x");
    expect(output(run1)).toEqual([]);
    expect(agentPaths(run1.seen)).toEqual([]);
  });

  it("M3: each item may run a sequence; every leaf gets [i]", async () => {
    const f = Agent({ id: "f" }).map(flow().step(agent("write")).step(agent("edit")), {
      input: () => [1, 2],
    });
    expect(agentPaths((await run(f, "x")).seen)).toEqual([
      "write[0]",
      "write[1]",
      "edit[0]",
      "edit[1]",
    ]);
  });

  it("M6: a non-list input fails with map.not-a-list", async () => {
    const f = Agent({ id: "f" })
      .step(triage)
      .map(agent("writer") as never);
    const run1 = await run(f, "x", () => ({ kind: "bug", summary: "" }));
    expect(failure(run1)).toMatchObject({ code: "map.not-a-list", path: "@1" });
  });

  it("M7: replay takes the journaled list", async () => {
    const f = Agent({ id: "f" }).map(agent("writer"), { input: () => [1, 2] });
    const first = await run(f, "x");
    expect(first.seen.filter((e) => e.kind === "fn")).toHaveLength(1);
  });

  it("nested Maps index every level", async () => {
    const f = Agent({ id: "f" }).map(flow().map(agent("cell")), { input: () => [[1, 2], [3]] });
    expect(agentPaths((await run(f, "x")).seen)).toEqual([
      "cell[0][0]",
      "cell[0][1]",
      "cell[1][0]",
    ]);
  });
});

describe("loop", () => {
  it("L2: a verify function runs as <key>:verify and sees the output", async () => {
    let n = 0;
    const f = Agent({ id: "f" }).loop(agent("coder"), {
      verify: ({ output }) =>
        String(output).endsWith("2") ? { pass: true } : { pass: false, feedback: "again" },
      max: 3,
      id: "fix",
    });
    const run1 = await run(f, "x", () => `try ${(n += 1)}`);
    expect(output(run1)).toBe("try 2");
    expect(keys(run1.seen)).toEqual(["fix:verify", "fix:verify"]);
    expect(agentPaths(run1.seen)).toEqual(["coder", "coder"]);
  });

  it("L3: a custom decide may return a variant, pinned for that turn", async () => {
    const coder = agent("coder");
    let turns = 0;
    const f = Agent({ id: "f" }).loop(coder, {
      verify: () => ({ pass: false, feedback: "too big" }),
      decide: ({ iteration, output, agent: current }) =>
        iteration >= 2
          ? { output }
          : { retry: "smaller", agent: withInstructions(current!, "Make a smaller change.") },
    });
    const run1 = await run(f, "x", ({ effect }) => {
      turns += 1;
      const manifest =
        (effect.input as { manifest?: AgentManifest }).manifest ?? coder.build().manifest;
      return agentTurnValue(`turn ${turns}`, manifest);
    });
    expect(output(run1)).toBe("turn 2");
    const inputs = run1.seen
      .filter((e) => e.kind === "agent")
      .map((e) => e.input as { manifest?: AgentManifest });
    expect(inputs[0]!.manifest).toBeUndefined();
    expect(inputs[1]!.manifest?.capabilities[0]?.instructions).toContain("Make a smaller change.");
    expect(keys(run1.seen)).toEqual(["@0:verify", "@0:decide", "@0:verify", "@0:decide"]);
  });

  it("L4: a looped sequence repeats; its sessions stay put across attempts", async () => {
    let attempt = 0;
    const f = Agent({ id: "f" }).loop(flow().step(agent("coder")).step(agent("runner")), {
      verify: () => ({ pass: (attempt += 1) >= 2 }) as never,
      max: 5,
    });
    const run1 = await run(f, "x");
    expect(agentPaths(run1.seen)).toEqual(["coder", "runner", "coder", "runner"]);
  });

  it("L5: wrapping a step in a Loop keeps its session path", async () => {
    const fixer = agent("fixer");
    const plain = await run(Agent({ id: "f" }).step(fixer), "x");
    const looped = await run(
      Agent({ id: "f" }).loop(fixer, { verify: () => ({ pass: true }), max: 2 }),
      "x",
    );
    expect(agentPaths(plain.seen)).toEqual(["fixer"]);
    expect(agentPaths(looped.seen)).toEqual(["fixer"]);
  });
});

describe("identity", () => {
  it("I1/I4: named and unnamed control stages key their functions; leaves keep their paths", async () => {
    const f = Agent({ id: "f" })
      .parallel({ a: agent("a"), b: agent("b") }, { id: "reviews", input: ({ input }) => input })
      .parallel({ c: agent("c"), d: agent("d") }, { input: ({ input }) => input });
    const run1 = await run(f, "x");
    expect(keys(run1.seen)).toEqual(["reviews:input", "@1:input"]);
    expect(agentPaths(run1.seen)).toEqual(["a", "b", "c", "d"]);
  });

  it("I2: .withId() names a child without an options object", async () => {
    const reviewer = agent("reviewer");
    const f = Agent({ id: "f" }).parallel({ a: reviewer, b: reviewer.withId("reviewer-b") });
    expect(agentPaths((await run(f, "x")).seen)).toEqual(["reviewer", "reviewer-b"]);
  });
});

describe("engine versions", () => {
  it("v1 manifests keep running on flow-1; a checkpoint never switches engines", async () => {
    const { Chain } = await import("@nylorun/core/define");
    const v1 = Chain({ id: "old", steps: [agent("a")] });
    const checkpoint = createFlowCheckpoint({
      manifest: v1.manifest,
      sessionId: "s",
      turnId: "t",
      input: "x",
    });
    expect(checkpoint.engineVersion).toBe("flow-1");
    const host: DurableHost = {
      async resolveEffect() {
        return { status: "completed", outcome: { value: "a out" } };
      },
    };
    await expect(
      runFlowDurable({ manifest: v1.manifest, checkpoint, host }),
    ).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      runFlowDurable({
        manifest: v1.manifest,
        checkpoint: { ...checkpoint, engineVersion: "flow-2" },
        host,
      }),
    ).rejects.toThrow(/Incompatible flow checkpoint/);
  });
});
