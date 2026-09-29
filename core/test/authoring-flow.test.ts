import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  flow,
  isBuiltWorkflow,
  tool,
  VerdictSchema,
} from "../src/define.js";

/** Flow Agents Phase 1: flow agents compile to today's WorkflowManifest v1. */

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
    if (error instanceof AgentBuildError) return error.diagnostics.map((d) => d.code);
    throw error;
  }
  return [];
};
// The shapes today's flow engine passes to slot `input` functions.
const slotArgs = (value: unknown, owner: unknown, results: Record<string, unknown> = {}) => ({
  value,
  input: owner,
  results,
});

describe("flow agents compile to WorkflowManifest v1", () => {
  it("is a workflow wherever an agent goes", () => {
    const desk = Agent({ id: "desk" }).step(agent("triage")).step(agent("writer"));
    expect(isBuiltWorkflow(desk)).toBe(true);
    expect(desk.manifest).toMatchObject({
      kind: "workflow",
      workflowSchemaVersion: 1,
      id: "desk",
      root: { chain: { id: "desk", steps: [{ agent: "triage" }, { agent: "writer" }] } },
    });
    expect(Object.keys(desk.getBinding().agents)).toEqual(["triage", "writer"]);
  });

  it("names control stages by id, else by kind and position", () => {
    const desk = Agent({ id: "desk" })
      .step(agent("triage"))
      .parallel({ security: agent("sec"), style: agent("sty") })
      .parallel({ a: agent("a"), b: agent("b") }, { id: "reviews" });
    const steps = (desk.manifest.root as { chain: { steps: unknown[] } }).chain.steps;
    expect(steps[1]).toMatchObject({ parallel: { id: "parallel-2" } });
    expect(steps[2]).toMatchObject({ parallel: { id: "reviews" } });
  });

  it("gives a step's input function { input, results, flowInput }", () => {
    const seen: unknown[] = [];
    const desk = Agent({ id: "desk" })
      .step(agent("triage"))
      .step(openPr, {
        input: (args) => {
          seen.push({ ...args });
          return { title: String((args.results as Record<string, unknown>).triage) };
        },
      });
    const input = desk.getBinding().nodes["desk/open_pr/input"];
    expect(input?.kind).toBe("fn");
    const out = input!.fn(slotArgs("triaged", "the issue", { triage: "triaged" }) as never);
    expect(out).toEqual({ title: "triaged" });
    expect(seen[0]).toEqual({ input: "triaged", results: { triage: "triaged" }, flowInput: "the issue" });
  });

  it("renames a step with { id } and reuses an agent twice", () => {
    const writer = agent("writer");
    const desk = Agent({ id: "desk" }).step(writer).step(agent("editor")).step(writer, { id: "final-writer" });
    const steps = (desk.manifest.root as { chain: { steps: unknown[] } }).chain.steps;
    expect(steps[2]).toEqual({ slot: { id: "final-writer", run: { agent: "writer" } } });
  });

  it("rejects the same agent twice without a new id", () => {
    const writer = agent("writer");
    expect(codesOf(() => Agent({ id: "desk" }).step(writer).step(writer).build())).toEqual([
      "workflow.duplicate-sibling",
    ]);
  });

  it("inlines .step(flow()) into the parent sequence", () => {
    const desk = Agent({ id: "desk" }).step(flow().step(agent("a")).step(agent("b"))).step(agent("c"));
    expect(desk.manifest.root).toMatchObject({
      chain: { steps: [{ agent: "a" }, { agent: "b" }, { agent: "c" }] },
    });
  });
});

describe("switch", () => {
  it("lifts default out of the cases and calls on directly at the first stage", () => {
    const route = Agent({ id: "route" }).switch(
      { bug: agent("fixer"), default: agent("general") },
      { on: ({ input }) => (input.kind === "bug" ? "bug" : "other") }
    );
    expect(route.manifest.root).toMatchObject({
      switch: { id: "route", cases: { bug: { agent: "fixer" } }, default: { agent: "general" } },
    });
    const on = route.getBinding().nodes["route/on"];
    expect(on!.fn({ kind: "bug" } as never)).toBe("bug");
  });

  it("uses an envelope after the first stage so on sees results and flowInput", () => {
    const seen: unknown[] = [];
    const desk = Agent({ id: "desk" })
      .step(agent("triage"))
      .switch(
        { bug: agent("fixer"), docs: agent("writer") },
        {
          id: "route",
          on: (args) => {
            seen.push({ ...args });
            return args.input.kind;
          },
        }
      );
    const nodes = desk.getBinding().nodes;
    const envelope = nodes["desk/route/input"]!.fn(
      slotArgs({ kind: "docs" }, "issue", { triage: { kind: "docs" } }) as never
    ) as Record<string, { key: string; value: unknown }>;
    expect(envelope.__nylorunSwitch).toEqual({ key: "docs", value: { kind: "docs" } });
    expect(seen[0]).toEqual({ input: { kind: "docs" }, results: { triage: { kind: "docs" } }, flowInput: "issue" });
    expect(nodes["desk/route/on"]!.fn(envelope as never)).toBe("docs");
    expect(nodes["desk/route/docs/input"]!.fn(slotArgs(envelope, envelope) as never)).toEqual({ kind: "docs" });
  });
});

describe("map", () => {
  it("runs over its input; input picks the list", () => {
    const desk = Agent({ id: "desk" })
      .step(agent("planner"))
      .map(agent("implementer"), { id: "build", input: ({ input }) => input.tasks });
    const nodes = desk.getBinding().nodes;
    expect(nodes["desk/build/over"]!.fn(["a", "b"] as never)).toEqual(["a", "b"]);
    expect(nodes["desk/build/input"]!.fn(slotArgs({ tasks: ["a", "b"] }, "x") as never)).toEqual(["a", "b"]);
  });

  it("explains that over is gone", () => {
    expect(() => Agent({ id: "desk" }).map(agent("w"), { over: () => [] } as never)).toThrow(/runs over its input/);
  });
});

describe("loop", () => {
  it("needs max or decide", () => {
    expect(codesOf(() => Agent({ id: "fix" }).loop(agent("fixer"), { verify: judge }).build())).toEqual([
      "loop.max-required",
    ]);
    expect(codesOf(() => Agent({ id: "fix" }).loop(agent("fixer"), { verify: judge, max: 0 }).build())).toEqual([
      "loop.invalid-max",
    ]);
  });

  it("decides by max: pass leaves, fail retries with feedback, the last fail stops", () => {
    const fix = Agent({ id: "fix" }).loop(agent("fixer"), { verify: judge, max: 2 });
    const decide = fix.getBinding().nodes["fix/decide"]!.fn as (args: unknown) => unknown;
    expect(decide({ output: "done", verdict: { pass: true }, iteration: 1 })).toEqual({ output: "done" });
    expect(decide({ output: "x", verdict: { pass: false, feedback: "tests fail" }, iteration: 1 })).toEqual({
      input: "tests fail",
    });
    expect(() => decide({ output: "x", verdict: { pass: false, feedback: "still" }, iteration: 2 })).toThrow(
      /stopped after 2 attempts: still/
    );
  });

  it("translates { retry, agent } from a custom decide", () => {
    const fix = Agent({ id: "fix" }).loop(agent("fixer"), {
      verify: () => ({ pass: false, feedback: "no" }),
      decide: ({ verdict }) => ({ retry: verdict.pass ? "" : verdict.feedback }),
    });
    const decide = fix.getBinding().nodes["fix/decide"]!.fn as (args: unknown) => unknown;
    expect(decide({ output: "x", verdict: { pass: false, feedback: "no" }, iteration: 5 })).toEqual({ input: "no" });
  });
});

describe("flow()", () => {
  it("compiles a multi-stage case to a Chain named after the case", () => {
    const desk = Agent({ id: "desk" }).switch(
      { bug: flow().step(agent("fixer")).step(agent("tester")), default: agent("general") },
      { on: () => "bug" }
    );
    expect(desk.manifest.root).toMatchObject({
      switch: { cases: { bug: { chain: { id: "bug", steps: [{ agent: "fixer" }, { agent: "tester" }] } } } },
    });
  });

  it("has no flowInput inside a nested flow() yet", () => {
    const desk = Agent({ id: "desk" }).switch(
      {
        bug: flow()
          .step(agent("fixer"))
          .step(openPr, { input: (args) => ({ title: String((args as { flowInput?: unknown }).flowInput) }) }),
      },
      { on: () => "bug" }
    );
    const input = desk.getBinding().nodes["desk/bug/open_pr/input"];
    expect(() => input!.fn(slotArgs("fixed", "case input") as never)).toThrow(/flow\.flow-input-nested/);
  });

  it("flow.empty when a flow has no stages", () => {
    expect(codesOf(() => Agent({ id: "desk" }).input(z.string()).build())).toEqual(["flow.empty"]);
  });
});

describe("sandbox on a flow agent", () => {
  it("declares the manifest's sandbox", () => {
    const desk = Agent({ id: "desk" }).sandbox({ image: "node:24" }).step(agent("triage"));
    expect(desk.manifest).toMatchObject({ sandbox: { image: "node:24" } });
  });

  it("must match the specs its agents declare until manifest v2", () => {
    const coder = Agent({ id: "coder" }).instructions("Code.").sandbox({ image: "node:22" });
    expect(codesOf(() => Agent({ id: "desk" }).sandbox({ image: "node:24" }).step(coder).build())).toEqual([
      "workflow.sandbox-mismatch",
    ]);
  });
});
