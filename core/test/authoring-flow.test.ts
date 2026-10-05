import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  Chain,
  flow,
  isBuiltWorkflow,
  tool,
  VerdictSchema,
  WorkflowBuildError,
} from "../src/define.js";
import { WorkflowManifestSchema } from "../src/contracts.js";

/** Flow Agents Phase 2: flow agents compile to workflow manifest v2. */

const agent = (id: string) => Agent({ id }).instructions(`Be ${id}.`);
const judge = Agent({ id: "judge" }).instructions("Judge.").output(VerdictSchema);
const openPr = tool({
  name: "open_pr",
  input: z.object({ title: z.string() }),
  async run({ title }) {
    return { url: `https://example.com/${title}` };
  },
});
const codesOf = (build: () => unknown): string[] => {
  try {
    build();
  } catch (error) {
    if (error instanceof AgentBuildError || error instanceof WorkflowBuildError)
      return error.diagnostics.map((d) => d.code);
    throw error;
  }
  return [];
};
const keysOf = (built: { getBinding(): { nodes: Record<string, unknown> } }) =>
  Object.keys(built.getBinding().nodes).sort();

const triage = agent("triage");
const fixer = agent("fixer");
const tester = agent("tester").output(VerdictSchema);
const docsWriter = agent("docs-writer");
const planner = agent("planner");
const implementer = agent("implementer");

const issueDesk = Agent({ id: "issue-desk", name: "Issue desk", description: "Triages issues." })
  .input(z.object({ repo: z.string(), issue: z.number().int() }))
  .output(z.object({ url: z.string() }))
  .step(triage)
  .switch(
    {
      bug: flow().loop(fixer, { verify: tester, max: 3 }),
      docs: docsWriter,
      default: flow()
        .step(planner)
        .map(implementer, { input: ({ input }) => input.tasks })
        .step(docsWriter, { id: "feature-docs" }),
    },
    { on: ({ input }) => input.kind, id: "route" }
  )
  .parallel({ security: agent("security-reviewer"), style: agent("style-reviewer") }, { id: "reviews" })
  .step(openPr, { input: ({ results }) => ({ title: String(results.triage) }) });

describe("flow agents compile to workflow manifest v2", () => {
  it("matches the design's issue-desk manifest", () => {
    const manifest = issueDesk.manifest;
    expect(isBuiltWorkflow(issueDesk)).toBe(true);
    expect(manifest).toMatchObject({
      kind: "workflow",
      workflowSchemaVersion: 2,
      id: "issue-desk",
      name: "Issue desk",
      description: "Triages issues.",
      inputSchema: { type: "object", required: ["repo", "issue"] },
      outputSchema: { type: "object", required: ["url"] },
    });
    expect(manifest.root).toEqual({
      chain: [
        { agent: "triage" },
        {
          switch: {
            on: { fn: true },
            cases: {
              bug: { loop: { run: { agent: "fixer" }, verify: { agent: "tester" }, max: 3 } },
              docs: { agent: "docs-writer" },
            },
            default: {
              chain: [
                { agent: "planner" },
                { map: { each: { agent: "implementer" } }, input: { fn: true } },
                { agent: "docs-writer", id: "feature-docs" },
              ],
            },
          },
          id: "route",
        },
        {
          parallel: { security: { agent: "security-reviewer" }, style: { agent: "style-reviewer" } },
          id: "reviews",
        },
        {
          tool: expect.objectContaining({ name: "open_pr" }),
          input: { fn: true },
        },
      ],
    });
    expect(Object.keys((manifest as { agents: object }).agents)).toEqual([
      "triage",
      "fixer",
      "tester",
      "docs-writer",
      "planner",
      "implementer",
      "security-reviewer",
      "style-reviewer",
    ]);
    expect((manifest as { agents: Record<string, unknown> }).agents.triage).toEqual(triage.build().manifest);
    expect(WorkflowManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("binds functions under stage keys: id, else position", () => {
    expect(keysOf(issueDesk)).toEqual([
      "@1.default.1:input",
      "open_pr",
      "open_pr:input",
      "route:on",
    ]);
  });

  it("registers the functions as written: they receive { input, results, flowInput }", () => {
    const nodes = issueDesk.getBinding().nodes;
    const on = nodes["route:on"]!.fn as (args: unknown) => unknown;
    expect(on({ input: { kind: "bug" }, results: {}, flowInput: {} })).toBe("bug");
    const title = nodes["open_pr:input"]!.fn as (args: unknown) => unknown;
    expect(title({ input: null, results: { triage: "fix it" }, flowInput: {} })).toEqual({ title: "fix it" });
  });

  it("puts id and input on any node, with no slots", () => {
    const desk = Agent({ id: "desk" })
      .step(agent("writer"), { id: "draft" })
      .parallel({ a: agent("a"), b: agent("b").withId("b2") }, { input: ({ input }) => input });
    expect(desk.manifest.root).toEqual({
      chain: [
        { agent: "writer", id: "draft" },
        { parallel: { a: { agent: "a" }, b: { agent: "b", id: "b2" } }, input: { fn: true } },
      ],
    });
    expect(keysOf(desk)).toEqual(["@1:input"]);
  });

  it("inlines .step(flow()) and wraps a flow() that has its own input", () => {
    const inlined = Agent({ id: "desk" }).step(flow().step(agent("a")).step(agent("b")));
    expect(inlined.manifest.root).toEqual({ chain: [{ agent: "a" }, { agent: "b" }] });
    const wrapped = Agent({ id: "desk" }).step(
      flow().step(agent("a"), { input: ({ input }) => input }),
      { input: ({ input }) => input }
    );
    expect(wrapped.manifest.root).toEqual({
      chain: [{ chain: [{ agent: "a", input: { fn: true } }], input: { fn: true } }],
    });
    expect(keysOf(wrapped)).toEqual(["@0:input", "a:input"]);
  });
});

describe("leaves and ids", () => {
  it("rejects the same agent twice without a new id (S4, W4, P2)", () => {
    const writer = agent("writer");
    expect(codesOf(() => Agent({ id: "d" }).step(writer).step(agent("editor")).step(writer).build())).toEqual([
      "flow.duplicate-leaf",
    ]);
    expect(codesOf(() => Agent({ id: "d" }).switch({ a: writer, b: writer }, { on: () => "a" }).build())).toEqual([
      "flow.duplicate-leaf",
    ]);
    expect(codesOf(() => Agent({ id: "d" }).parallel({ a: writer, b: writer }).build())).toEqual([
      "flow.duplicate-leaf",
    ]);
  });

  it("reuses one definition under a new id (S5)", () => {
    const writer = agent("writer");
    const desk = Agent({ id: "d" }).step(writer).step(writer, { id: "final-writer" });
    expect(desk.manifest.root).toEqual({
      chain: [{ agent: "writer" }, { agent: "writer", id: "final-writer" }],
    });
    expect(Object.keys((desk.manifest as { agents: object }).agents)).toEqual(["writer"]);
  });

  it("rejects two stages with the same id, and two different agents with one id", () => {
    expect(
      codesOf(() =>
        Agent({ id: "d" }).parallel({ a: agent("a") }, { id: "x" }).parallel({ b: agent("b") }, { id: "x" }).build()
      )
    ).toEqual(["flow.duplicate-id"]);
    expect(codesOf(() => Agent({ id: "d" }).step(agent("w")).step(Agent({ id: "w" }).instructions("Other."), { id: "w2" }).build())).toEqual(
      expect.arrayContaining(["flow.agent-conflict"])
    );
  });
});

describe("named agents are agents, not tools", () => {
  // An unbuilt AgentBuilder has `name` and an `.input()` method, which once made it look like a tool.
  const named = (id: string) =>
    Agent({ id, name: `Named ${id}` }).instructions(`Be ${id}.`).output(z.object({ y: z.string() }));

  it("in step, switch, parallel, map and loop", () => {
    const step = Agent({ id: "f" }).step(named("a")).build();
    expect(step.manifest.root).toEqual({ chain: [{ agent: "a" }] });
    const sw = Agent({ id: "s" }).switch({ a: named("a"), default: named("b") }, { on: () => "a" }).build();
    expect(JSON.stringify(sw.manifest.root)).toContain('"agent":"a"');
    const par = Agent({ id: "p" }).parallel({ a: named("a"), b: named("b") }).build();
    expect(JSON.stringify(par.manifest.root)).toContain('"agent":"b"');
    const map = Agent({ id: "m" }).step(agent("splitter")).map(named("w")).build();
    expect(JSON.stringify(map.manifest.root)).toContain('"agent":"w"');
    const named_judge = Agent({ id: "nj", name: "Named judge" }).instructions("Judge.").output(VerdictSchema);
    const loop = Agent({ id: "l" }).loop(named("fixer"), { verify: named_judge, max: 2 }).build();
    expect(JSON.stringify(loop.manifest.root)).toContain('"agent":"nj"');
    const agentsOf = (built: { getBinding(): { agents: Record<string, unknown> } }) =>
      Object.keys(built.getBinding().agents).sort();
    expect(agentsOf(step)).toEqual(["a"]);
    expect(agentsOf(sw)).toEqual(["a", "b"]);
    expect(agentsOf(par)).toEqual(["a", "b"]);
    expect(agentsOf(map)).toEqual(["splitter", "w"]);
    expect(agentsOf(loop)).toEqual(["fixer", "nj"]);
  });

  it("built, and in Chain", () => {
    expect(Agent({ id: "f" }).step(named("a").build()).build().manifest.root).toEqual({ chain: [{ agent: "a" }] });
    expect(Chain({ id: "c", steps: [named("a"), named("b")] }).manifest.root).toEqual({
      chain: { id: "c", steps: [{ agent: "a" }, { agent: "b" }] },
    });
  });
});

describe("loop", () => {
  it("needs max or decide", () => {
    expect(codesOf(() => Agent({ id: "fix" }).loop(fixer, { verify: judge }).build())).toEqual([
      "loop.max-required",
    ]);
    expect(codesOf(() => Agent({ id: "fix" }).loop(fixer, { verify: judge, max: 0 }).build())).toEqual([
      "loop.invalid-max",
    ]);
  });

  it("carries max in the manifest; decide and verify functions are bound", () => {
    const fix = Agent({ id: "fix" }).loop(fixer, {
      verify: ({ output }) => (output ? { pass: true } : { pass: false, feedback: "empty" }),
      decide: ({ verdict, output }) => (verdict.pass ? { output } : { retry: "again" }),
      max: 4,
    });
    expect(fix.manifest.root).toEqual({
      chain: [{ loop: { run: { agent: "fixer" }, verify: { fn: true }, max: 4, decide: { fn: true } } }],
    });
    expect(keysOf(fix)).toEqual(["@0:decide", "@0:verify"]);
    expect(fix.getBinding().nodes["@0:verify"]!.kind).toBe("verify");
  });

  it("verify must be a function or an agent", () => {
    expect(codesOf(() => Agent({ id: "fix" }).loop(fixer, { verify: openPr, max: 2 }).build())).toEqual([
      "loop.invalid-verify",
    ]);
  });
});

describe("map", () => {
  it("is { map: { each } } over its input", () => {
    const desk = Agent({ id: "desk" }).step(agent("splitter")).map(agent("writer"));
    expect(desk.manifest.root).toEqual({ chain: [{ agent: "splitter" }, { map: { each: { agent: "writer" } } }] });
    expect(keysOf(desk)).toEqual([]);
  });

  it("explains that over is gone", () => {
    expect(() => Agent({ id: "desk" }).map(agent("w"), { over: () => [] } as never)).toThrow(/runs over its input/);
  });
});

describe("nested flow agents (S7)", () => {
  it("embeds the flow agent and binds its functions under its id", () => {
    const inner = Agent({ id: "review" }).step(agent("reader")).step(openPr, { input: () => ({ title: "t" }) });
    const outer = Agent({ id: "outer" }).step(agent("writer")).step(inner);
    expect(outer.manifest.root).toEqual({ chain: [{ agent: "writer" }, { agent: "review" }] });
    const agents = (outer.manifest as { agents: Record<string, { kind?: string }> }).agents;
    expect(agents.review).toEqual(inner.manifest);
    expect(keysOf(outer)).toEqual(["review/open_pr", "review/open_pr:input"]);
    expect(Object.keys(outer.getBinding().agents).sort()).toEqual(["reader", "writer"]);
  });

  it("rejects a workflow built with the old primitives, and a flow agent inside them", () => {
    const old = Chain({ id: "old", steps: [agent("a")] });
    expect(codesOf(() => Agent({ id: "outer" }).step(old).build())).toEqual(["flow.v1-workflow"]);
    expect(() => Chain({ id: "c", steps: [Agent({ id: "f" }).step(agent("a"))] })).toThrow(/can't be a child of Chain/);
  });
});

describe("flow()", () => {
  it("compiles a multi-stage case to a chain, a single stage to itself", () => {
    const desk = Agent({ id: "desk" }).switch(
      { bug: flow().step(fixer).step(tester), docs: flow().step(docsWriter), default: agent("general") },
      { on: () => "bug" }
    );
    expect(desk.manifest.root).toMatchObject({
      chain: [
        {
          switch: {
            cases: { bug: { chain: [{ agent: "fixer" }, { agent: "tester" }] }, docs: { agent: "docs-writer" } },
            default: { agent: "general" },
          },
        },
      ],
    });
  });

  it("flow.empty when a flow has no stages", () => {
    expect(codesOf(() => Agent({ id: "desk" }).input(z.string()).build())).toEqual(["flow.empty"]);
  });
});

describe("sandbox on a flow agent", () => {
  it("is not part of the definition: the session is opened with one", () => {
    const desk = Agent({ id: "desk" }).step(Agent({ id: "coder" }).instructions("Code."));
    expect("sandbox" in (desk as object)).toBe(false);
    expect(desk.manifest).not.toHaveProperty("sandbox");
  });
});

describe("Agent.from reads a v2 flow document", () => {
  it("rebuilds the flow from its JSON and the code its stage keys name", () => {
    const json = JSON.parse(JSON.stringify(issueDesk.manifest));
    const onKind = ({ input }: { input: { kind: string } }) => input.kind;
    const rebuilt = Agent.from(json, {
      nodes: {
        "route:on": onKind,
        "@1.default.1:input": ({ input }: { input: { tasks: string[] } }) => input.tasks,
        "open_pr:input": () => ({ title: "t" }),
        open_pr: openPr,
      },
    });
    expect(isBuiltWorkflow(rebuilt)).toBe(true);
    expect(rebuilt.manifest).toEqual(issueDesk.manifest);
    expect(keysOf(rebuilt)).toEqual(keysOf(issueDesk));
    expect(rebuilt.getBinding().nodes["route:on"]).toEqual({ kind: "fn", fn: onKind });
    expect(Object.keys(rebuilt.getBinding().agents).sort()).toEqual(
      Object.keys(issueDesk.getBinding().agents).sort()
    );
  });

  it("names missing and unknown stage keys", () => {
    const json = JSON.parse(JSON.stringify(issueDesk.manifest));
    expect(() => Agent.from(json, { nodes: { "route:on": () => "bug" } })).toThrow(
      /Missing flow implementations: @1.default.1:input, open_pr:input, open_pr/
    );
    const small = Agent({ id: "s" }).step(agent("a")).manifest;
    expect(() => Agent.from(JSON.parse(JSON.stringify(small)), { nodes: { "nope:on": () => "x" } })).toThrow(
      /no stage key nope:on/
    );
  });
});

describe("workflow manifest v2 schema", () => {
  const base = { kind: "workflow", workflowSchemaVersion: 2, id: "f", agents: { a: { manifestSchemaVersion: 5, id: "a", capabilities: [] } } };
  it("accepts v1 and v2, and checks embedded agents and loop limits", () => {
    expect(WorkflowManifestSchema.safeParse({ ...base, root: { chain: [{ agent: "a" }] } }).success).toBe(true);
    expect(WorkflowManifestSchema.safeParse({ ...base, root: { agent: "b" } }).success).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({ ...base, root: { loop: { run: { agent: "a" }, verify: { fn: true } } } }).success
    ).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({ ...base, root: { slot: { run: { agent: "a" } } } }).success
    ).toBe(false);
    expect(
      WorkflowManifestSchema.safeParse({
        ...base,
        agents: { b: { manifestSchemaVersion: 5, id: "a", capabilities: [] } },
        root: { agent: "b" },
      }).success
    ).toBe(false);
  });
});
