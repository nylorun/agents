import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  flow,
  isBuiltWorkflow,
  isVerdict,
  tool,
  VerdictSchema,
  WorkflowBuildError,
} from "../src/define.js";
import { WorkflowManifestSchema } from "../src/contracts.js";
import { resetDeprecationWarnings } from "../src/utils/deprecate.js";

/** Flow agents compile to workflow manifest v3: data only, no functions. */

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
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return `${(error as { code?: string }).code}: ${(error as Error).message}`;
  }
  return "built";
};
const keysOf = (built: { getBinding(): { nodes: Record<string, unknown> } }) =>
  Object.keys(built.getBinding().nodes).sort();

const triage = agent("triage").output(
  z.object({ route: z.enum(["bug", "docs", "feature"]), summary: z.string() })
);
const fixer = agent("fixer");
const tester = agent("tester").output(VerdictSchema);
const docsWriter = agent("docs-writer");
const planner = agent("planner").output(z.object({ items: z.array(z.string()) }));
const implementer = agent("implementer");
const titler = agent("titler").output(z.object({ title: z.string() }));

const issueDesk = Agent({ id: "issue-desk", name: "Issue desk", description: "Triages issues." })
  .input(z.object({ repo: z.string(), issue: z.number().int() }))
  .output(z.object({ url: z.string() }))
  .pipe(triage)
  .switch(
    {
      bug: flow().loop(fixer, { verify: tester, max: 3 }),
      docs: docsWriter,
      default: flow().pipe(planner).map(implementer).pipe(docsWriter.withId("feature-docs")),
    },
    { id: "route" }
  )
  .parallel({ security: agent("security-reviewer"), style: agent("style-reviewer") }, { id: "reviews" })
  .pipe(titler, openPr);

describe("flow agents compile to workflow manifest v3", () => {
  it("matches the issue-desk manifest", () => {
    const manifest = issueDesk.manifest;
    expect(isBuiltWorkflow(issueDesk)).toBe(true);
    expect(manifest).toMatchObject({
      kind: "workflow",
      workflowSchemaVersion: 3,
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
            cases: {
              bug: { loop: { run: { agent: "fixer" }, verify: { agent: "tester" }, max: 3 } },
              docs: { agent: "docs-writer" },
            },
            default: {
              chain: [
                { agent: "planner" },
                { map: { each: { agent: "implementer" } } },
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
        { agent: "titler" },
        { tool: expect.objectContaining({ name: "open_pr" }) },
      ],
    });
    expect(JSON.stringify(manifest.root)).not.toMatch(/"fn"|"input"|"on"|"decide"/);
    expect(Object.keys(manifest.agents)).toEqual([
      "triage",
      "fixer",
      "tester",
      "docs-writer",
      "planner",
      "implementer",
      "security-reviewer",
      "style-reviewer",
      "titler",
    ]);
    expect(manifest.agents.triage).toEqual(triage.build().manifest);
    expect(WorkflowManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("binds only tool nodes, under their stage keys", () => {
    expect(keysOf(issueDesk)).toEqual(["open_pr"]);
    expect(issueDesk.getBinding().nodes.open_pr!.kind).toBe("tool");
  });

  it("pipe adds one stage per child, in order", () => {
    const desk = Agent({ id: "desk" }).pipe(agent("a"), agent("b"), agent("c").withId("c2"));
    expect(desk.manifest.root).toEqual({
      chain: [{ agent: "a" }, { agent: "b" }, { agent: "c", id: "c2" }],
    });
    expect(Agent({ id: "desk" }).pipe(agent("a")).pipe(agent("b")).pipe(agent("c").withId("c2")).manifest).toEqual(
      desk.manifest
    );
  });

  it("inlines .pipe(flow()) and keeps a named flow() as its own chain", () => {
    const inlined = Agent({ id: "desk" }).pipe(flow().pipe(agent("a"), agent("b")));
    expect(inlined.manifest.root).toEqual({ chain: [{ agent: "a" }, { agent: "b" }] });
    const named = Agent({ id: "desk" }).pipe(flow().pipe(agent("a"), agent("b")).withId("draft"));
    expect(named.manifest.root).toEqual({
      chain: [{ chain: [{ agent: "a" }, { agent: "b" }], id: "draft" }],
    });
  });
});

describe("function options are refused with what replaces them", () => {
  it("input", () => {
    expect(refusal(() => Agent({ id: "d" }).parallel({ a: fixer }, { input: () => "x" } as never))).toBe(
      "configuration.invalid: .parallel() no longer takes 'input': stages get the previous output; return what the next stage needs from the previous agent's output schema (see MIGRATION.md)."
    );
    expect(refusal(() => Agent({ id: "d" }).map(fixer, { input: () => [] } as never))).toMatch(
      /\.map\(\) no longer takes 'input'/
    );
  });

  it("on", () => {
    expect(refusal(() => Agent({ id: "d" }).switch({ a: fixer }, { on: () => "a" } as never))).toBe(
      "configuration.invalid: .switch() no longer takes 'on': switch reads the previous output: a string or its `route` field (see MIGRATION.md)."
    );
  });

  it("a verify function", () => {
    expect(
      refusal(() => Agent({ id: "d" }).loop(fixer, { verify: () => ({ pass: true }), max: 2 } as never))
    ).toBe(
      "configuration.invalid: .loop() no longer takes a verify function: use a verifier agent or an HTTP verifier, http({ url }) (see MIGRATION.md)."
    );
  });

  it("decide", () => {
    expect(
      refusal(() => Agent({ id: "d" }).loop(fixer, { verify: judge, max: 2, decide: () => ({}) } as never))
    ).toBe(
      "configuration.invalid: .loop() no longer takes 'decide': removed; the loop retries with the verifier's feedback until max (see MIGRATION.md)."
    );
  });

  it("a function as a child, and no child", () => {
    expect(refusal(() => Agent({ id: "d" }).pipe((() => 1) as never))).toMatch(
      /\.pipe\(\) takes an agent, tool or flow\(\), not a function/
    );
    expect(refusal(() => Agent({ id: "d" }).pipe())).toMatch(/\.pipe\(\) requires at least one/);
  });
});

describe(".step() is a deprecated alias of .pipe()", () => {
  let codes: string[] = [];
  beforeEach(() => {
    resetDeprecationWarnings();
    codes = [];
    vi.spyOn(process, "emitWarning").mockImplementation(((
      _message: string,
      options?: { code?: string }
    ) => {
      if (options?.code) codes.push(options.code);
    }) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("compiles like .pipe() and warns once", () => {
    const stepped = Agent({ id: "d" }).step(agent("a")).step(agent("b"), { id: "b2" });
    expect(stepped.manifest.root).toEqual({ chain: [{ agent: "a" }, { agent: "b", id: "b2" }] });
    expect(codes).toEqual(["NYLORUN_DEP_STEP"]);
    Agent({ id: "e" }).pipe(agent("a")).build();
    expect(codes).toEqual(["NYLORUN_DEP_STEP"]);
  });

  it("refuses input like every stage", () => {
    expect(refusal(() => Agent({ id: "d" }).step(fixer, { input: () => "x" } as never))).toMatch(
      /\.step\(\) no longer takes 'input'/
    );
  });
});

describe("leaves and ids", () => {
  it("rejects the same agent twice without a new id", () => {
    const writer = agent("writer");
    expect(codesOf(() => Agent({ id: "d" }).pipe(writer, agent("editor"), writer).build())).toEqual([
      "flow.duplicate-leaf",
    ]);
    expect(codesOf(() => Agent({ id: "d" }).switch({ a: writer, b: writer }).build())).toEqual([
      "flow.duplicate-leaf",
    ]);
    expect(codesOf(() => Agent({ id: "d" }).parallel({ a: writer, b: writer }).build())).toEqual([
      "flow.duplicate-leaf",
    ]);
  });

  it("reuses one definition under a new id", () => {
    const writer = agent("writer");
    const desk = Agent({ id: "d" }).pipe(writer, writer.withId("final-writer"));
    expect(desk.manifest.root).toEqual({
      chain: [{ agent: "writer" }, { agent: "writer", id: "final-writer" }],
    });
    expect(Object.keys(desk.manifest.agents)).toEqual(["writer"]);
  });

  it("rejects two stages with the same id, and two different agents with one id", () => {
    expect(
      codesOf(() =>
        Agent({ id: "d" }).parallel({ a: agent("a") }, { id: "x" }).parallel({ b: agent("b") }, { id: "x" }).build()
      )
    ).toEqual(["flow.duplicate-id"]);
    expect(
      codesOf(() =>
        Agent({ id: "d" }).pipe(agent("w"), Agent({ id: "w" }).instructions("Other.").withId("w2")).build()
      )
    ).toEqual(expect.arrayContaining(["flow.agent-conflict"]));
  });
});

describe("named agents are agents, not tools", () => {
  // An unbuilt AgentBuilder has `name` and an `.input()` method, which once made it look like a tool.
  const named = (id: string) =>
    Agent({ id, name: `Named ${id}` }).instructions(`Be ${id}.`).output(z.object({ y: z.string() }));

  it("in pipe, switch, parallel, map and loop", () => {
    const pipe = Agent({ id: "f" }).pipe(named("a")).build();
    expect(pipe.manifest.root).toEqual({ chain: [{ agent: "a" }] });
    const sw = Agent({ id: "s" }).switch({ a: named("a"), default: named("b") }).build();
    expect(JSON.stringify(sw.manifest.root)).toContain('"agent":"a"');
    const par = Agent({ id: "p" }).parallel({ a: named("a"), b: named("b") }).build();
    expect(JSON.stringify(par.manifest.root)).toContain('"agent":"b"');
    const map = Agent({ id: "m" }).pipe(agent("splitter")).map(named("w")).build();
    expect(JSON.stringify(map.manifest.root)).toContain('"agent":"w"');
    const namedJudge = Agent({ id: "nj", name: "Named judge" }).instructions("Judge.").output(VerdictSchema);
    const loop = Agent({ id: "l" }).loop(named("fixer"), { verify: namedJudge, max: 2 }).build();
    expect(JSON.stringify(loop.manifest.root)).toContain('"agent":"nj"');
    const agentsOf = (built: { getBinding(): { agents: Record<string, unknown> } }) =>
      Object.keys(built.getBinding().agents).sort();
    expect(agentsOf(pipe)).toEqual(["a"]);
    expect(agentsOf(sw)).toEqual(["a", "b"]);
    expect(agentsOf(par)).toEqual(["a", "b"]);
    expect(agentsOf(map)).toEqual(["splitter", "w"]);
    expect(agentsOf(loop)).toEqual(["fixer", "nj"]);
  });

  it("built", () => {
    expect(Agent({ id: "f" }).pipe(named("a").build()).build().manifest.root).toEqual({
      chain: [{ agent: "a" }],
    });
  });
});

describe("loop", () => {
  it("needs a positive integer max", () => {
    expect(codesOf(() => Agent({ id: "fix" }).loop(fixer, { verify: judge } as never).build())).toEqual([
      "loop.max-required",
    ]);
    expect(codesOf(() => Agent({ id: "fix" }).loop(fixer, { verify: judge, max: 0 }).build())).toEqual([
      "loop.invalid-max",
    ]);
  });

  it("carries the verifier agent and max in the manifest, and binds nothing", () => {
    const fix = Agent({ id: "fix" }).loop(fixer, { verify: judge, max: 4 });
    expect(fix.manifest.root).toEqual({
      chain: [{ loop: { run: { agent: "fixer" }, verify: { agent: "judge" }, max: 4 } }],
    });
    expect(keysOf(fix)).toEqual([]);
  });

  it("verify must be an agent", () => {
    expect(codesOf(() => Agent({ id: "fix" }).loop(fixer, { verify: openPr, max: 2 }).build())).toEqual([
      "loop.invalid-verify",
    ]);
    expect(() => Agent({ id: "fix" }).loop(fixer, { max: 2 } as never)).toThrow(/requires \{ verify \}/);
  });

  it("a verdict needs feedback on failure", () => {
    expect(isVerdict({ pass: true })).toBe(true);
    expect(isVerdict({ pass: false, feedback: "nope" })).toBe(true);
    expect(isVerdict({ pass: false })).toBe(false);
  });
});

describe("map", () => {
  it("is { map: { each } } over the previous output", () => {
    const desk = Agent({ id: "desk" }).pipe(planner).map(agent("writer"));
    expect(desk.manifest.root).toEqual({ chain: [{ agent: "planner" }, { map: { each: { agent: "writer" } } }] });
    expect(keysOf(desk)).toEqual([]);
  });

  it("explains that over is gone", () => {
    expect(() => Agent({ id: "desk" }).map(agent("w"), { over: () => [] } as never)).toThrow(
      /runs over the previous output: an array, or its `items` field/
    );
  });
});

describe("tool nodes", () => {
  it("may take a non-object schema", () => {
    // Raw definition: tool() would reject non-object input for agent tools.
    const openMany = {
      name: "open-many",
      inputSchema: z.array(z.string()),
      run: async (summaries: string[]) => ({ opened: summaries.length }),
    };
    const ship = Agent({ id: "ship" }).pipe(planner, openMany as never);
    const node = ship.getBinding().nodes["open-many"];
    expect(node?.tool.inputSchema.jsonSchema.type).toBe("array");
  });
});

describe("nested flow agents", () => {
  it("embeds the flow agent and binds its tool nodes under its id", () => {
    const inner = Agent({ id: "review" }).pipe(agent("reader"), titler, openPr);
    const outer = Agent({ id: "outer" }).pipe(agent("writer"), inner);
    expect(outer.manifest.root).toEqual({ chain: [{ agent: "writer" }, { agent: "review" }] });
    expect(outer.manifest.agents.review).toEqual(inner.manifest);
    expect(keysOf(outer)).toEqual(["review/open_pr"]);
    expect(Object.keys(outer.getBinding().agents).sort()).toEqual(["reader", "titler", "writer"]);
  });
});

describe("flow()", () => {
  it("compiles a multi-stage case to a chain, a single stage to itself", () => {
    const desk = Agent({ id: "desk" }).switch({
      bug: flow().pipe(fixer, tester),
      docs: flow().pipe(docsWriter),
      default: agent("general"),
    });
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
    const desk = Agent({ id: "desk" }).pipe(Agent({ id: "coder" }).instructions("Code."));
    expect("sandbox" in (desk as object)).toBe(false);
    expect(desk.manifest).not.toHaveProperty("sandbox");
  });
});

describe("Agent.from reads a v3 flow document", () => {
  it("rebuilds the flow from its JSON and the tools its tool nodes name", () => {
    const json = JSON.parse(JSON.stringify(issueDesk.manifest));
    const rebuilt = Agent.from(json, { nodes: { open_pr: openPr } });
    expect(isBuiltWorkflow(rebuilt)).toBe(true);
    expect(rebuilt.manifest).toEqual(issueDesk.manifest);
    expect(keysOf(rebuilt)).toEqual(keysOf(issueDesk));
    expect(Object.keys(rebuilt.getBinding().agents).sort()).toEqual(
      Object.keys(issueDesk.getBinding().agents).sort()
    );
  });

  it("names missing and unknown tool nodes", () => {
    const json = JSON.parse(JSON.stringify(issueDesk.manifest));
    expect(() => Agent.from(json, {})).toThrow(/Missing flow implementation: open_pr/);
    const small = Agent({ id: "s" }).pipe(agent("a")).manifest;
    expect(() => Agent.from(JSON.parse(JSON.stringify(small)), { nodes: { nope: openPr } })).toThrow(
      /no tool node nope/
    );
  });

  it("refuses a v2 document with what changed", () => {
    const json = { ...JSON.parse(JSON.stringify(issueDesk.manifest)), workflowSchemaVersion: 2 };
    expect(() => Agent.from(json, { nodes: { open_pr: openPr } })).toThrow(
      /workflowSchemaVersion 2 is no longer supported: flows run no code/
    );
  });
});
