import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  embeddedAgent,
  flow,
  tool,
  VerdictSchema,
  type JsonValue,
  type WorkflowManifest,
} from "@nylorun/core/define";
import {
  createFlowCheckpoint,
  runFlowDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../../src/run/index.js";
import { flowEffectId, iterationsOf, nodeKeyOf } from "../../src/flow/index.js";

/**
 * Flow agents end to end on the `flow-3` engine: workflow manifest v3 is data, so every
 * effect is an agent turn or a tool node. Leaf agents resolve from the embedded `agents`;
 * tool effects run through the flow's own bindings, as the Action endpoint does.
 */

type Built = {
  readonly manifest: WorkflowManifest;
  getBinding(): {
    nodes: Record<string, { tool: { execute(input: unknown, ctx: never): Promise<unknown> } }>;
  };
};

type AgentCall = {
  agentId: string;
  input: unknown;
  flowInput?: unknown;
  path: string;
  effect: HostEffect;
};

async function run(
  workflow: unknown,
  input: JsonValue,
  agents: (call: AgentCall) => unknown = ({ agentId }) => `${agentId} out`,
  options: {
    limits?: { maxMapItems?: number; maxLoopIterations?: number };
    pending?: (effect: HostEffect) => boolean;
  } = {},
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
      if (options.pending?.(effect)) {
        journal.set(effect.effectId, { status: "pending" });
        return { status: "pending" };
      }
      let value: unknown;
      if (effect.kind === "agent") {
        const body = effect.input as AgentCall & { flow?: string[] };
        const leaf = embeddedAgent(built.manifest, body.flow ?? [], body.agentId);
        if (!leaf || "kind" in leaf) throw new Error(`No embedded agent '${body.agentId}'`);
        value = agents({ ...body, effect });
      } else {
        const impl = nodes[effect.key];
        if (!impl) throw new Error(`No tool binding for key '${effect.key}'`);
        value = { kind: "completed", output: await impl.tool.execute(effect.input, {} as never) };
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
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { result, seen, journal };
}

const agentPaths = (seen: HostEffect[]) =>
  seen.filter((e) => e.kind === "agent").map((e) => e.path);
const agentInputs = (seen: HostEffect[], path: string) =>
  seen
    .filter((e) => e.kind === "agent" && e.path === path)
    .map((e) => (e.input as { input: unknown }).input);
const output = (value: Awaited<ReturnType<typeof run>>) =>
  (value.result as { result?: { output?: unknown } }).result?.output;
const failure = (value: Awaited<ReturnType<typeof run>>) =>
  (value.result as { result?: { error?: { code: string; message: string; path?: string } } }).result
    ?.error;

const agent = (id: string) => Agent({ id }).instructions(`Be ${id}.`);
const Review = z.object({ score: z.number() });
const triage = agent("triage").output(
  z.object({ route: z.enum(["bug", "docs", "feature"]), summary: z.string() }),
);
const planner = agent("planner").output(z.object({ items: z.array(z.string()) }));
const tester = agent("tester").output(VerdictSchema);
const docsWriter = agent("docs-writer");
const titler = agent("titler").output(z.object({ title: z.string() }));
const openPr = tool({
  name: "open_pr",
  input: z.object({ title: z.string() }),
  output: z.object({ url: z.string() }),
  async run({ title }) {
    return { url: `https://example.com/pr/${encodeURIComponent(title)}` };
  },
});

const issueDesk = Agent({ id: "issue-desk" })
  .pipe(triage)
  .switch(
    {
      bug: flow().loop(agent("fixer"), { verify: tester, max: 3 }),
      docs: docsWriter,
      default: flow()
        .pipe(planner)
        .map(agent("implementer"))
        .pipe(docsWriter.withId("feature-docs")),
    },
    { id: "route" },
  )
  .parallel(
    {
      security: agent("security-reviewer").output(Review),
      style: agent("style-reviewer").output(Review),
    },
    { id: "reviews" },
  )
  .pipe(titler, openPr);

function desk(route: "bug" | "docs" | "feature", failures = 1) {
  let attempts = 0;
  return ({ agentId, input }: AgentCall): unknown => {
    switch (agentId) {
      case "triage":
        return { route, summary: `fix ${route}` };
      case "fixer":
        attempts += 1;
        return `patch ${attempts}`;
      case "tester":
        return attempts > failures
          ? { pass: true }
          : { pass: false, feedback: `attempt ${attempts} fails` };
      case "planner":
        return { items: ["api", "ui"] };
      case "implementer":
        return `done ${String(input)}`;
      case "docs-writer":
        return "docs updated";
      case "security-reviewer":
        return { score: 4 };
      case "style-reviewer":
        return { score: 5 };
      case "titler": {
        const { security, style } = input as Record<string, { score: number }>;
        return { title: `reviewed ${security!.score}/${style!.score}` };
      }
      default:
        throw new Error(`unexpected agent ${agentId}`);
    }
  };
}

describe("issue-desk on flow-3", () => {
  it("names sessions by leaf: control stages add nothing, a Map item adds [i]", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 7 }, desk("feature"));
    expect(output(run1)).toEqual({ url: "https://example.com/pr/reviewed%204%2F5" });
    expect(agentPaths(run1.seen)).toEqual([
      "triage",
      "planner",
      "implementer[0]",
      "implementer[1]",
      "feature-docs",
      "security-reviewer",
      "style-reviewer",
      "titler",
    ]);
    expect(run1.seen.filter((e) => e.kind === "tool").map((e) => e.key)).toEqual(["open_pr"]);
    expect(run1.seen.every((e) => e.kind === "agent" || e.kind === "tool")).toBe(true);
    expect(run1.result.checkpoint.engineVersion).toBe("flow-3");
  });

  it("routes docs straight to the docs writer", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 9 }, desk("docs"));
    expect(agentPaths(run1.seen)).toContain("docs-writer");
    expect(output(run1)).toMatchObject({ url: expect.any(String) });
  });

  it("retries the loop body in the same session with the verifier's feedback", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 8 }, desk("bug", 1));
    expect(output(run1)).toMatchObject({ url: expect.any(String) });
    const fixer = run1.seen.filter((e) => e.kind === "agent" && e.path === "fixer");
    expect(fixer.map((e) => (e.input as { input: unknown }).input)).toEqual([
      { route: "bug", summary: "fix bug" },
      "attempt 1 fails",
    ]);
    expect(fixer.map((e) => e.iterations)).toEqual(["1", "2"]);
    expect(fixer.map((e) => e.context)).toEqual([
      { loopPath: "@1.bug", n: 1 },
      { loopPath: "@1.bug", n: 2 },
    ]);
    const judge = run1.seen.filter((e) => e.kind === "agent" && e.path === "tester");
    expect(judge.map((e) => e.context)).toEqual([
      { loopPath: "@1.bug", n: 1, role: "verify-agent" },
      { loopPath: "@1.bug", n: 2, role: "verify-agent" },
    ]);
    expect(agentInputs(run1.seen, "tester")).toEqual([
      { task: { route: "bug", summary: "fix bug" }, response: "patch 1", iteration: 1 },
      { task: { route: "bug", summary: "fix bug" }, response: "patch 2", iteration: 2 },
    ]);
  });

  it("ends the run with loop.exhausted after max failed attempts", async () => {
    const run1 = await run(issueDesk, { repo: "r", issue: 1 }, desk("bug", 99));
    expect(run1.result.status).toBe("failed");
    expect(failure(run1)).toMatchObject({ code: "loop.exhausted", path: "@1.bug" });
    expect(failure(run1)!.message).toBe("Loop stopped after 3 attempts: attempt 3 fails");
  });
});

describe("pipe", () => {
  it("gives the first stage the flow input and each later stage the previous output", async () => {
    const f = Agent({ id: "f" }).pipe(agent("a"), agent("b"), agent("c"));
    const run1 = await run(f, "task", ({ agentId, input }) => `${agentId}(${String(input)})`);
    expect(agentInputs(run1.seen, "a")).toEqual(["task"]);
    expect(agentInputs(run1.seen, "b")).toEqual(["a(task)"]);
    expect(agentInputs(run1.seen, "c")).toEqual(["b(a(task))"]);
    expect(output(run1)).toBe("c(b(a(task)))");
  });

  it("an agent's output feeds a tool node directly", async () => {
    const run1 = await run(Agent({ id: "f" }).pipe(titler, openPr), "x", () => ({ title: "s" }));
    expect(output(run1)).toEqual({ url: "https://example.com/pr/s" });
    const node = run1.seen.find((e) => e.kind === "tool")!;
    expect(node.input).toEqual({ title: "s" });
    expect(node.path).toBe("open_pr");
  });

  it("a reused agent gets a session per id", async () => {
    const writer = agent("writer");
    const run1 = await run(Agent({ id: "f" }).pipe(writer, writer.withId("final-writer")), "x");
    expect(agentPaths(run1.seen)).toEqual(["writer", "final-writer"]);
    expect(run1.seen.map((e) => (e.input as { agentId: string }).agentId)).toEqual([
      "writer",
      "writer",
    ]);
  });

  it("a nested flow agent's leaves run under its id, with its own input", async () => {
    const review = Agent({ id: "review" }).pipe(agent("reader"), agent("critic"));
    const outer = Agent({ id: "outer" }).pipe(agent("writer"), review);
    const run1 = await run(outer, "task");
    expect(agentPaths(run1.seen)).toEqual(["writer", "review/reader", "review/critic"]);
    expect(run1.seen[1]!.input).toEqual({
      agentId: "reader",
      input: "writer out",
      path: "review/reader",
      flow: ["review"],
    });
    // The nested flow agent's input is the original request its own stages see.
    expect(run1.seen[2]!.input).toMatchObject({ input: "reader out", flowInput: "writer out" });
  });
});

describe("the original request (D12)", () => {
  it("rides on every agent effect whose input is not the flow's input", async () => {
    const run1 = await run(Agent({ id: "f" }).pipe(agent("a"), agent("b")), { ask: "ship it" });
    expect(run1.seen[0]!.input).not.toHaveProperty("flowInput");
    expect(run1.seen[1]!.input).toMatchObject({ input: "a out", flowInput: { ask: "ship it" } });
  });

  it("is left out when the stage's input is the flow's input", async () => {
    const f = Agent({ id: "f" }).parallel({ a: agent("a"), b: agent("b") });
    const run1 = await run(f, { x: 1, y: 2 });
    expect(run1.seen.every((e) => !("flowInput" in (e.input as object)))).toBe(true);
  });
});

describe("switch", () => {
  const cases = { bug: agent("fixer"), docs: agent("writer") };

  it("picks the case a string output names", async () => {
    const f = Agent({ id: "f" }).pipe(agent("router")).switch(cases);
    const run1 = await run(f, "x", ({ agentId }) => (agentId === "router" ? "docs" : agentId));
    expect(output(run1)).toBe("writer");
    expect(agentInputs(run1.seen, "writer")).toEqual(["docs"]);
  });

  it("picks the case an object's route field names, and passes the whole output", async () => {
    const f = Agent({ id: "f" }).pipe(triage).switch(cases);
    const run1 = await run(f, "x", ({ agentId }) =>
      agentId === "triage" ? { route: "bug", summary: "s" } : agentId,
    );
    expect(output(run1)).toBe("fixer");
    expect(agentInputs(run1.seen, "fixer")).toEqual([{ route: "bug", summary: "s" }]);
  });

  it("falls back to default", async () => {
    const f = Agent({ id: "f" })
      .pipe(agent("router"))
      .switch({ ...cases, default: agent("general") });
    const run1 = await run(f, "x", ({ agentId }) => (agentId === "router" ? "other" : agentId));
    expect(output(run1)).toBe("general");
    const run2 = await run(f, "x", ({ agentId }) => (agentId === "router" ? { n: 1 } : agentId));
    expect(output(run2)).toBe("general");
  });

  it("fails switch.no-match naming what it read", async () => {
    const f = Agent({ id: "f" }).pipe(agent("router")).switch(cases);
    const unknown = await run(f, "x", () => ({ route: "other" }));
    expect(failure(unknown)).toMatchObject({ code: "switch.no-match", path: "@1" });
    expect(failure(unknown)!.message).toBe(
      'Switch read the case name "other", but no case has that name (cases: bug, docs) and there is no default case',
    );
    const unnamed = await run(f, "x", () => ({ kind: "bug" }));
    expect(failure(unnamed)).toMatchObject({ code: "switch.no-match" });
    expect(failure(unnamed)!.message).toContain('Switch read {"kind":"bug"}, which names no case');
  });

  it("a case that is a sequence names its leaves directly", async () => {
    const runTests = tool({
      name: "run_tests",
      input: z.object({}).passthrough(),
      async run() {
        return "green";
      },
    });
    const f = Agent({ id: "f" }).switch({ bug: flow().pipe(agent("fixer"), runTests) });
    const run1 = await run(f, "bug", () => ({}));
    expect(run1.seen.map((e) => e.path)).toEqual(["fixer", "run_tests"]);
    expect(output(run1)).toBe("green");
  });
});

describe("parallel", () => {
  it("gives every branch the same input; the output is keyed by branch", async () => {
    const f = Agent({ id: "f" })
      .pipe(agent("draft"))
      .parallel({ security: agent("sec"), style: agent("sty") });
    const run1 = await run(f, "x");
    expect(agentPaths(run1.seen)).toEqual(["draft", "sec", "sty"]);
    expect(agentInputs(run1.seen, "sec")).toEqual(["draft out"]);
    expect(agentInputs(run1.seen, "sty")).toEqual(["draft out"]);
    expect(output(run1)).toEqual({ security: "sec out", style: "sty out" });
  });

  it("one failing branch fails the stage with the leaf's path and cancels pending siblings", async () => {
    const f = Agent({ id: "f" }).parallel({ a: agent("a"), b: agent("b"), c: agent("c") });
    const run1 = await run(
      f,
      "x",
      ({ agentId }) =>
        agentId === "b" ? { kind: "failed", code: "agent.failed", message: "b broke" } : "ok",
      { pending: (e) => e.path === "c" },
    );
    expect(failure(run1)).toMatchObject({ code: "agent.failed", path: "b" });
    const pending = run1.seen.find((e) => e.path === "c")!;
    expect(run1.result).toMatchObject({ cancelEffectIds: [pending.effectId] });
  });

  it("waits while a branch is pending", async () => {
    const f = Agent({ id: "f" }).parallel({ a: agent("a"), b: agent("b") });
    const run1 = await run(f, "x", undefined, { pending: (e) => e.path === "b" });
    expect(run1.result).toMatchObject({
      status: "waiting",
      effectIds: [run1.seen.find((e) => e.path === "b")!.effectId],
    });
  });
});

describe("map", () => {
  it("runs over an array output, one session per item, output in item order", async () => {
    const splitter = agent("splitter").output(z.array(z.string()));
    const f = Agent({ id: "f" }).pipe(splitter).map(agent("writer"));
    const run1 = await run(f, "x", ({ agentId, input }) =>
      agentId === "splitter" ? ["a", "b", "c"] : `w:${String(input)}`,
    );
    expect(agentPaths(run1.seen)).toEqual(["splitter", "writer[0]", "writer[1]", "writer[2]"]);
    expect(output(run1)).toEqual(["w:a", "w:b", "w:c"]);
  });

  it("runs over an object's items", async () => {
    const f = Agent({ id: "f" }).pipe(planner).map(agent("writer"));
    const run1 = await run(f, "x", ({ agentId, input }) =>
      agentId === "planner" ? { items: ["api", "ui"], note: "two" } : `w:${String(input)}`,
    );
    expect(output(run1)).toEqual(["w:api", "w:ui"]);
  });

  it("an empty list opens no sessions", async () => {
    const f = Agent({ id: "f" }).pipe(planner).map(agent("writer"));
    const run1 = await run(f, "x", () => ({ items: [] }));
    expect(output(run1)).toEqual([]);
    expect(agentPaths(run1.seen)).toEqual(["planner"]);
  });

  it("each item may run a sequence; every leaf gets [i]", async () => {
    const f = Agent({ id: "f" }).map(flow().pipe(agent("write"), agent("edit")));
    expect(agentPaths((await run(f, [1, 2])).seen)).toEqual([
      "write[0]",
      "write[1]",
      "edit[0]",
      "edit[1]",
    ]);
  });

  it("fails map.not-a-list for anything else", async () => {
    const f = Agent({ id: "f" }).pipe(triage).map(agent("writer"));
    const run1 = await run(f, "x", () => ({ route: "bug", summary: "" }));
    expect(failure(run1)).toMatchObject({ code: "map.not-a-list", path: "@1" });
    expect(failure(run1)!.message).toBe(
      'A Map runs over an array or { items: [...] }; got {"route":"bug","summary":""}',
    );
    const items = await run(f, "x", () => ({ items: "nope" }));
    expect(failure(items)).toMatchObject({ code: "map.not-a-list" });
  });

  it("stops at the operator's item ceiling before any item starts", async () => {
    const f = Agent({ id: "f" }).map(agent("writer"), { id: "write" });
    const run1 = await run(f, [0, 1, 2], undefined, { limits: { maxMapItems: 2 } });
    expect(failure(run1)).toMatchObject({ code: "map.too-many-items", path: "write" });
    expect(agentPaths(run1.seen)).toEqual([]);
  });

  it("nested Maps index every level", async () => {
    const f = Agent({ id: "f" }).map(flow().map(agent("cell")));
    expect(agentPaths((await run(f, [[1, 2], [3]])).seen)).toEqual([
      "cell[0][0]",
      "cell[0][1]",
      "cell[1][0]",
    ]);
  });
});

describe("loop", () => {
  const judge = agent("judge").output(VerdictSchema);

  it("stops on the first pass", async () => {
    const f = Agent({ id: "f" }).loop(agent("coder"), { verify: judge, max: 3, id: "fix" });
    const run1 = await run(f, "x", ({ agentId }) =>
      agentId === "judge" ? { pass: true } : "code",
    );
    expect(output(run1)).toBe("code");
    expect(agentPaths(run1.seen)).toEqual(["coder", "judge"]);
  });

  it("retries with the feedback until a pass", async () => {
    let n = 0;
    const f = Agent({ id: "f" }).loop(agent("coder"), { verify: judge, max: 3, id: "fix" });
    const run1 = await run(f, "x", ({ agentId }) => {
      if (agentId === "coder") return `try ${(n += 1)}`;
      return n >= 2 ? { pass: true } : { pass: false, feedback: "again" };
    });
    expect(output(run1)).toBe("try 2");
    expect(agentInputs(run1.seen, "coder")).toEqual(["x", "again"]);
    expect(agentPaths(run1.seen)).toEqual(["coder", "judge", "coder", "judge"]);
  });

  it("fails loop.exhausted after max", async () => {
    const f = Agent({ id: "f" }).loop(agent("coder"), { verify: judge, max: 2, id: "fix" });
    const run1 = await run(f, "x", ({ agentId }) =>
      agentId === "judge" ? { pass: false, feedback: "still red" } : "code",
    );
    expect(failure(run1)).toMatchObject({
      code: "loop.exhausted",
      path: "fix",
      message: "Loop stopped after 2 attempts: still red",
    });
    expect(agentPaths(run1.seen)).toEqual(["coder", "judge", "coder", "judge"]);
  });

  it("fails loop.verify-failed when the verifier returns no verdict", async () => {
    const f = Agent({ id: "f" }).loop(agent("coder"), { verify: judge, max: 2, id: "fix" });
    for (const verdict of [{ score: 3 }, { pass: false }, "yes"]) {
      const run1 = await run(f, "x", ({ agentId }) => (agentId === "judge" ? verdict : "code"));
      expect(failure(run1)).toMatchObject({ code: "loop.verify-failed", path: "fix" });
      expect(failure(run1)!.message).toContain(
        "The verifier must return { pass: boolean, feedback?: string }",
      );
    }
  });

  it("fails loop.verify-failed when the verifier's turn fails", async () => {
    const f = Agent({ id: "f" }).loop(agent("coder"), { verify: judge, max: 2, id: "fix" });
    const run1 = await run(f, "x", ({ agentId }) =>
      agentId === "judge"
        ? { kind: "failed", code: "agent.failed", message: "judge broke" }
        : "code",
    );
    expect(failure(run1)).toEqual({
      code: "loop.verify-failed",
      message: "judge broke",
      path: "fix",
    });
  });

  it("a looped sequence repeats; its sessions stay put across attempts", async () => {
    let attempt = 0;
    const f = Agent({ id: "f" }).loop(flow().pipe(agent("coder"), agent("runner")), {
      verify: judge,
      max: 5,
    });
    const run1 = await run(f, "x", ({ agentId }) =>
      agentId === "judge"
        ? (attempt += 1) >= 2
          ? { pass: true }
          : { pass: false, feedback: "no" }
        : agentId,
    );
    expect(agentPaths(run1.seen)).toEqual(["coder", "runner", "judge", "coder", "runner", "judge"]);
  });

  it("wrapping a step in a Loop keeps its session path", async () => {
    const fixer = agent("fixer");
    const plain = await run(Agent({ id: "f" }).pipe(fixer), "x");
    const looped = await run(
      Agent({ id: "f" }).loop(fixer, { verify: judge, max: 2 }),
      "x",
      ({ agentId }) => (agentId === "judge" ? { pass: true } : "fixed"),
    );
    expect(agentPaths(plain.seen)).toEqual(["fixer"]);
    expect(agentPaths(looped.seen)).toEqual(["fixer", "judge"]);
  });

  it("stops at the operator's iteration ceiling", async () => {
    const f = Agent({ id: "f" }).loop(agent("coder"), { verify: judge, max: 10, id: "fix" });
    const run1 = await run(
      f,
      "x",
      ({ agentId }) => (agentId === "judge" ? { pass: false, feedback: "again" } : "code"),
      { limits: { maxLoopIterations: 3 } },
    );
    expect(failure(run1)).toMatchObject({ code: "loop.too-many-iterations", path: "fix" });
    expect(agentPaths(run1.seen).filter((path) => path === "coder")).toHaveLength(3);
  });
});

describe("identity", () => {
  it(".withId() names a child; control stages add nothing to leaf paths", async () => {
    const reviewer = agent("reviewer");
    const f = Agent({ id: "f" }).parallel(
      { a: reviewer, b: reviewer.withId("reviewer-b") },
      { id: "reviews" },
    );
    expect(agentPaths((await run(f, "x")).seen)).toEqual(["reviewer", "reviewer-b"]);
  });

  it("paths, keys, iterations and effect ids", () => {
    expect(nodeKeyOf("implement[2]/code")).toBe("implement/code");
    expect(iterationsOf([])).toBe("-");
    expect(iterationsOf([2, 1])).toBe("2.1");
    expect(
      flowEffectId({
        turnId: "t",
        segment: 0,
        path: "implement[2]",
        kind: "agent",
        iterations: "1",
      }),
    ).toBe("t:0:flow:implement[2]:agent:1");
  });
});

describe("engine versions", () => {
  it("v3 manifests run on flow-3; a checkpoint never switches engines", async () => {
    const f = Agent({ id: "f" }).pipe(agent("a"));
    const checkpoint = createFlowCheckpoint({
      manifest: f.manifest,
      sessionId: "s",
      turnId: "t",
      input: "x",
    });
    expect(checkpoint.engineVersion).toBe("flow-3");
    const host: DurableHost = {
      async resolveEffect() {
        return { status: "completed", outcome: { value: "a out" } };
      },
    };
    await expect(runFlowDurable({ manifest: f.manifest, checkpoint, host })).resolves.toMatchObject(
      {
        status: "completed",
      },
    );
    await expect(
      runFlowDurable({
        manifest: f.manifest,
        checkpoint: { ...checkpoint, engineVersion: "flow-2" as never },
        host,
      }),
    ).rejects.toThrow(/Incompatible flow checkpoint/);
  });

  it("refuses a v2 manifest with what changed", () => {
    const v2 = { ...Agent({ id: "f" }).pipe(agent("a")).manifest, workflowSchemaVersion: 2 };
    expect(() =>
      createFlowCheckpoint({ manifest: v2 as never, sessionId: "s", turnId: "t", input: "x" }),
    ).toThrow(/workflowSchemaVersion 2 is no longer supported: flows run no code/);
  });
});
