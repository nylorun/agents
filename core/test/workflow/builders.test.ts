import { expect, it, describe } from "vitest";
import { z } from "zod";
import { Agent, tool } from "../../src/define.js";
import { WorkflowManifestSchema } from "../../src/contracts.js";
import {
  Chain,
  Switch,
  Parallel,
  Map,
  Loop,
  Verdict,
  isVerdict,
  withInstructions,
  withoutTools,
  WorkflowBuildError,
  isBuiltWorkflow,
  isSlot,
} from "../../src/definition/workflow/index.js";

const agent = (id: string, sandbox?: { image: string }) => {
  const builder = Agent({ id, name: id });
  if (sandbox) return builder.use({ id: "box", sandbox }).build();
  return builder.build();
};

const echo = tool({
  name: "echo",
  input: z.object({ text: z.string() }),
  run: async ({ text }) => text,
});

describe("Chain", () => {
  it("CHAIN-D1/B1: builds a non-empty steps chain with manifest and binding", () => {
    const a = agent("researcher");
    const b = agent("analyst");
    const report = Chain({ id: "report", steps: [a, b] });
    expect(isBuiltWorkflow(report)).toBe(true);
    expect(report.id).toBe("report");
    expect(Object.keys(report)).not.toContain("getBinding");
    expect(report.toJSON()).toEqual(report.manifest);
    expect(report.manifest.kind).toBe("workflow");
    expect(report.manifest.root).toMatchObject({
      chain: { id: "report", steps: [{ agent: "researcher" }, { agent: "analyst" }] },
    });
    expect(WorkflowManifestSchema.safeParse(report.manifest).success).toBe(true);
    const binding = report.getBinding();
    expect(binding.manifest).toBe(report.manifest);
    expect(Object.keys(binding.agents).sort()).toEqual(["analyst", "researcher"]);
  });

  it("CHAIN-B1: empty steps fails the build", () => {
    expect(() => Chain({ id: "empty", steps: [] as never })).toThrow(WorkflowBuildError);
  });

  it("CHAIN-B2/D4: duplicate step ids fail; slot id renames", () => {
    const writer = agent("writer");
    expect(() => Chain({ id: "dup", steps: [writer, writer] })).toThrow(/Duplicate/);
    const renamed = Chain({
      id: "draft-twice",
      steps: [
        { run: writer, id: "draft" },
        { run: writer, id: "redraft" },
      ],
    });
    expect(renamed.manifest.root).toMatchObject({
      chain: {
        steps: [
          { slot: { id: "draft", run: { agent: "writer" } } },
          { slot: { id: "redraft", run: { agent: "writer" } } },
        ],
      },
    });
  });

  it("WF-R7/R8/R9: slot reshape registers an input fn under the step path", () => {
    const a = agent("researcher");
    const b = agent("analyst");
    const report = Chain({
      id: "report",
      steps: [
        a,
        {
          run: b,
          input: ({ input, results }) =>
            `Topic: ${(input as { topic: string }).topic}\n${results.researcher}`,
        },
      ],
    });
    const binding = report.getBinding();
    expect(binding.nodes["report/analyst/input"]?.kind).toBe("fn");
    expect(report.manifest.root).toMatchObject({
      chain: {
        steps: [
          { agent: "researcher" },
          { slot: { input: { fn: true }, run: { agent: "analyst" } } },
        ],
      },
    });
  });

  it("WF-R17: invalid path parts fail", () => {
    expect(() => Chain({ id: "a/b", steps: [agent("x")] })).toThrow(/path part/);
  });

  it("accepts a tool node and keeps its implementation", () => {
    const publish = tool({
      name: "publish",
      input: z.object({ body: z.string() }),
      run: async ({ body }) => ({ ok: true, body }),
    });
    const flow = Chain({ id: "pipe", steps: [agent("writer"), publish] });
    expect(flow.getBinding().nodes["pipe/publish"]?.kind).toBe("tool");
  });
});

describe("Switch", () => {
  it("SWITCH-D1/B1: builds cases with on fn", () => {
    const sw = Switch({
      id: "route",
      on: (ticket: { kind: string }) => ticket.kind,
      cases: { bug: agent("bug-fix"), billing: agent("billing") },
      default: agent("general"),
    });
    expect(sw.manifest.root).toMatchObject({
      switch: {
        id: "route",
        on: { fn: true },
        cases: { bug: { agent: "bug-fix" }, billing: { agent: "billing" } },
        default: { agent: "general" },
      },
    });
    expect(sw.getBinding().nodes["route/on"]?.kind).toBe("fn");
    expect(WorkflowManifestSchema.safeParse(sw.manifest).success).toBe(true);
  });

  it("SWITCH-B1: empty cases fail", () => {
    expect(() =>
      Switch({ id: "x", on: () => "a", cases: {} as never }),
    ).toThrow(/at least one/);
  });

  it("SWITCH-B2/D3/R5: default is reserved as a case key", () => {
    expect(() =>
      Switch({
        id: "x",
        on: () => "default",
        cases: { default: agent("a") } as never,
      }),
    ).toThrow(/reserved/);
  });

  it("SWITCH-B3: invalid case keys fail", () => {
    expect(() =>
      Switch({
        id: "x",
        on: () => "a",
        cases: { "a/b": agent("a") },
      }),
    ).toThrow(/path part/);
  });
});

describe("Parallel", () => {
  it("PAR-D1/B1: builds named branches; output object shape in manifest", () => {
    const p = Parallel({
      id: "review",
      branches: {
        security: agent("security-reviewer"),
        style: agent("style-reviewer"),
      },
    });
    expect(p.manifest.root).toMatchObject({
      parallel: {
        id: "review",
        branches: {
          security: { agent: "security-reviewer" },
          style: { agent: "style-reviewer" },
        },
      },
    });
    expect(Object.keys((p.manifest.root as { parallel: { branches: object } }).parallel.branches)).toEqual([
      "security",
      "style",
    ]);
  });

  it("PAR-B1: empty branches fail", () => {
    expect(() => Parallel({ id: "x", branches: {} as never })).toThrow(/at least one/);
  });

  it("PAR-B2: invalid branch names fail", () => {
    expect(() =>
      Parallel({ id: "x", branches: { "a[0]": agent("a") } }),
    ).toThrow(/path part/);
  });
});

describe("Map", () => {
  it("MAP-D1/B1: builds over + each with over fn", () => {
    const m = Map({
      id: "write",
      over: (plan: { sections: string[] }) => plan.sections,
      each: agent("section-writer"),
    });
    expect(m.manifest.root).toMatchObject({
      map: {
        id: "write",
        over: { fn: true },
        each: { agent: "section-writer" },
      },
    });
    expect(m.getBinding().nodes["write/over"]?.kind).toBe("fn");
  });

  it("WF-R19: a slot id renames a nested workflow's node keys to the slot path", () => {
    const shout = tool({
      name: "shout",
      input: z.object({ word: z.string() }),
      run: async ({ word }) => word.toUpperCase(),
    });
    const wrapped = Chain({
      id: "wrapped",
      steps: [
        {
          id: "loud",
          run: Map({ id: "each", over: (v: string[]) => v, each: shout }),
          input: ({ value }) => value,
        },
      ],
    });
    expect(Object.keys(wrapped.getBinding().nodes).sort()).toEqual([
      "wrapped/loud/input",
      "wrapped/loud/over",
      "wrapped/loud/shout",
    ]);
  });

  it("LOOP-R5: a verifier slot input is keyed under the verifier's path", () => {
    const judge = Agent({
      id: "judge",
      instructions: "Judge.",
      outputSchema: Verdict,
    }).build();
    const essay = Loop({
      id: "essay",
      run: agent("writer"),
      verify: { run: judge, input: ({ value }) => value },
      decide: ({ output }) => ({ output }),
    });
    expect(essay.getBinding().nodes["essay/judge/input"]?.kind).toBe("fn");
  });

  it("MAP-B1: missing over or each fails", () => {
    expect(() =>
      Map({ id: "x", over: undefined as never, each: agent("a") }),
    ).toThrow(/over/);
    expect(() =>
      Map({ id: "x", over: () => [], each: undefined as never }),
    ).toThrow(/each/);
  });

  it("MAP-D5: Map and Parallel are separate exports", () => {
    expect(Map).not.toBe(Parallel);
    expect(Map.name).toBe("Map");
    expect(Parallel.name).toBe("Parallel");
  });
});

describe("Loop", () => {
  it("LOOP-R1/B1/D2: requires run, verify, decide; accepts any runnable", () => {
    const coder = agent("coder");
    const loop = Loop({
      id: "fix-tests",
      run: coder,
      verify: () => ({ pass: true }),
      decide: ({ output }) => ({ output }),
    });
    expect(loop.manifest.root).toMatchObject({
      loop: {
        id: "fix-tests",
        run: { agent: "coder" },
        verify: { fn: true },
        decide: { fn: true },
      },
    });
    expect(loop.getBinding().nodes["fix-tests"]?.kind).toBe("verify");
    expect(loop.getBinding().nodes["fix-tests/decide"]?.kind).toBe("fn");

    expect(() =>
      Loop({ id: "x", run: coder, verify: undefined as never, decide: () => ({ output: 1 }) }),
    ).toThrow(/verify/);
    expect(() =>
      Loop({ id: "x", run: coder, verify: () => ({ pass: true }), decide: undefined as never }),
    ).toThrow(/decide/);
  });

  it("LOOP-D2: run accepts a nested Chain", () => {
    const chain = Chain({ id: "inner", steps: [agent("a"), agent("b")] });
    const loop = Loop({
      id: "wrap",
      run: chain,
      verify: () => ({ pass: true }),
      decide: ({ output }) => ({ output }),
    });
    expect(loop.manifest.root).toMatchObject({
      loop: { run: { chain: { id: "inner" } } },
    });
    expect(Object.keys(loop.getBinding().agents).sort()).toEqual(["a", "b"]);
  });

  it("LOOP-B2/R4: verifier agent outputSchema must extend Verdict", () => {
    const writer = agent("writer");
    const badJudge = Agent({ id: "bad-judge", outputSchema: z.object({ score: z.number() }) }).build();
    expect(() =>
      Loop({
        id: "essay",
        run: writer,
        verify: badJudge,
        decide: ({ output }) => ({ output }),
      }),
    ).toThrow(/Verdict/);

    const judge = Agent({
      id: "judge",
      outputSchema: Verdict.extend({ data: z.object({ score: z.number() }).optional() }),
    }).build();
    const loop = Loop({
      id: "essay",
      run: writer,
      verify: judge,
      decide: ({ output, verdict }) => (verdict.pass ? { output } : { input: "retry" }),
    });
    expect(loop.manifest.root).toMatchObject({
      loop: { verify: { agent: "judge" } },
    });
  });

  it("LOOP-R2: Verdict requires feedback on failure", () => {
    expect(isVerdict({ pass: true })).toBe(true);
    expect(isVerdict({ pass: false, feedback: "nope" })).toBe(true);
    expect(isVerdict({ pass: false })).toBe(false);
  });
});

describe("slots", () => {
  it("WF-R10/D5: slot is a plain object; isSlot detects it", () => {
    const a = agent("a");
    expect(isSlot({ run: a, id: "x" })).toBe(true);
    expect(isSlot(a)).toBe(false);
    expect(isSlot(echo)).toBe(false);
  });
});

describe("sandbox", () => {
  it("WF-R29/PAR-B3: mismatched sandbox specs fail the build", () => {
    expect(() =>
      Parallel({
        id: "review",
        branches: {
          a: agent("a", { image: "node:22" }),
          b: agent("b", { image: "python:3" }),
        },
      }),
    ).toThrow(/identical spec/);
  });

  it("WF-R57: matching sandboxes are declared once on the document", () => {
    const spec = { image: "node:22" };
    const flow = Parallel({
      id: "review",
      branches: {
        a: agent("a", spec),
        b: agent("b", spec),
      },
    });
    expect(flow.manifest.sandbox).toEqual(spec);
  });
});

describe("withInstructions / withoutTools", () => {
  it("LOOP-R14/D4: patch helpers are pure and return new manifests", () => {
    const coder = Agent({
      id: "coder",
      instructions: "Fix tests.",
      tools: [echo],
    }).build();
    const patched = withInstructions(coder.manifest, "Run the suite first.");
    expect(patched).not.toBe(coder.manifest);
    expect(patched.capabilities[0]?.instructions).toEqual([
      "Fix tests.",
      "Run the suite first.",
    ]);
    expect(coder.manifest.capabilities[0]?.instructions).toEqual(["Fix tests."]);

    const stripped = withoutTools(coder.manifest, ["echo"]);
    expect(stripped.capabilities[0]?.tools ?? []).toEqual([]);
    expect(coder.manifest.capabilities[0]?.tools?.map((t) => t.name)).toEqual(["echo"]);
  });
});

describe("WF-R36 tool nodes", () => {
  it("a tool used only as a node may take a non-object schema", () => {
    // Raw definition — tool() would reject non-object input for agent tools.
    const openPr = {
      name: "open-pr",
      inputSchema: z.array(z.string()),
      run: async (summaries: string[]) => ({ opened: summaries.length }),
    };
    const flow = Chain({ id: "ship", steps: [agent("planner"), openPr as never] });
    const node = flow.getBinding().nodes["ship/open-pr"];
    expect(node?.kind).toBe("tool");
    if (node?.kind === "tool") {
      expect(node.tool.inputSchema.jsonSchema.type).toBe("array");
    }
  });
});

describe("composition", () => {
  it("WF-C1/D1: nest Chain → Map → Loop → tool like the design example", () => {
    const planner = agent("planner");
    const coder = agent("coder");
    const openPr = tool({
      name: "open-pr",
      input: z.object({ summaries: z.array(z.string()) }),
      run: async (args) => args,
    });
    const ship = Chain({
      id: "ship-feature",
      steps: [
        planner,
        Map({
          id: "implement",
          over: (plan: { tasks: string[] }) => plan.tasks,
          each: Loop({
            id: "code",
            run: coder,
            verify: () => ({ pass: true }),
            decide: ({ output }) => ({ output }),
          }),
        }),
        openPr,
      ],
    });
    expect(WorkflowManifestSchema.safeParse(ship.manifest).success).toBe(true);
    expect(ship.getBinding().nodes["ship-feature/implement/over"]?.kind).toBe("fn");
    expect(ship.getBinding().nodes["ship-feature/implement/code"]?.kind).toBe("verify");
    expect(ship.getBinding().nodes["ship-feature/implement/code/decide"]?.kind).toBe("fn");
    expect(ship.getBinding().nodes["ship-feature/open-pr"]?.kind).toBe("tool");
    expect(Object.keys(ship.getBinding().agents).sort()).toEqual(["coder", "planner"]);
  });
});
