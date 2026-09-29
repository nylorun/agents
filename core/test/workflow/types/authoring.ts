/**
 * Compile-time tests for Flow Agents Phase 1: data types flow from each stage's
 * output to the next stage's `input`, and mistakes are type errors.
 * Run via: tsc -p test/workflow/types/tsconfig.json
 */
import { z } from "zod";
import { Agent, flow, tool, type BuiltWorkflow } from "../../../src/define.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

const triage = Agent({ id: "triage" })
  .instructions("Classify.")
  .output(z.object({ kind: z.enum(["bug", "docs", "feature"]), summary: z.string() }));
const planner = Agent({ id: "planner" }).instructions("Plan.").output(z.object({ tasks: z.array(z.string()) }));
const splitter = Agent({ id: "splitter" }).instructions("Split.").output(z.array(z.string()));
const implementer = Agent({ id: "implementer" }).instructions("Implement.");
const fixer = Agent({ id: "fixer" }).instructions("Fix.");
const general = Agent({ id: "general" }).instructions("Answer.");
const security = Agent({ id: "security" }).instructions("Review.").output(z.object({ score: z.number() }));
const style = Agent({ id: "style" }).instructions("Review.").output(z.object({ score: z.number() }));
const openPr = tool({
  name: "open_pr",
  input: z.object({ title: z.string() }),
  async run({ title }) {
    return title;
  },
});

// The previous step's output types `input`.
Agent({ id: "route" })
  .step(triage)
  .switch(
    { bug: fixer, docs: general, feature: implementer },
    {
      on: ({ input }) => {
        type _kind = Assert<Equals<typeof input.kind, "bug" | "docs" | "feature">>;
        return input.kind;
      },
    }
  );

Agent({ id: "typo" })
  .step(triage)
  .switch(
    { bug: fixer, default: general },
    {
      // @ts-expect-error kynd does not exist on triage's output
      on: ({ input }) => input.kynd,
    }
  );

// Without a default case, `on` must return a case name.
Agent({ id: "strict" })
  .step(triage)
  // @ts-expect-error "other" is not a case
  .switch({ bug: fixer }, { on: () => "other" as const });

// With a default case, any string is fine.
Agent({ id: "loose" }).step(triage).switch({ bug: fixer, default: general }, { on: () => "anything" });

// `results` is typed for steps whose id is known.
Agent({ id: "results" })
  .step(triage)
  .step(planner)
  .step(openPr, {
    input: ({ results }) => {
      type _summary = Assert<Equals<typeof results.triage.summary, string>>;
      type _tasks = Assert<Equals<typeof results.planner.tasks, string[]>>;
      // @ts-expect-error no step called nope
      void results.nope;
      return { title: results.triage.summary };
    },
  });

// A Map needs an array input.
Agent({ id: "map-ok" }).step(planner).map(implementer, { input: ({ input }) => input.tasks });
Agent({ id: "map-direct" }).step(splitter).map(implementer);
// @ts-expect-error triage's output is not a list, so .map() needs an input function
Agent({ id: "map-bad" }).step(triage).map(implementer);

// Parallel output is keyed by branch.
Agent({ id: "reviews" })
  .parallel({ security, style }, { id: "reviews" })
  .step(openPr, {
    input: ({ input, results }) => {
      type _score = Assert<Equals<typeof input.security.score, number>>;
      type _named = Assert<Equals<typeof results.reviews.style.score, number>>;
      return { title: String(input.security.score) };
    },
  });

// Loop functions see the body's output.
Agent({ id: "fix" }).loop(planner, {
  verify: ({ output }) => {
    type _out = Assert<Equals<typeof output.tasks, string[]>>;
    return output.tasks.length ? { pass: true } : { pass: false, feedback: "no tasks" };
  },
  decide: ({ verdict, output }) => (verdict.pass ? { output } : { retry: verdict.feedback }),
});

// A flow agent has no ReAct methods.
// @ts-expect-error flow agents run no model
Agent({ id: "flow" }).step(triage).instructions("x");

// flow() sequences type their own stages, and see the nearest Agent's input as flowInput.
flow()
  .step(triage)
  .step(openPr, {
    input: (args) => {
      void args.flowInput;
      return { title: args.input.summary };
    },
  });

// The build is a workflow typed by its last stage, or by .output().
const built = Agent({ id: "built" }).step(triage).step(planner).build();
type _built = Assert<Equals<typeof built, BuiltWorkflow<any, { tasks: string[] }>>>;
const declared = Agent({ id: "declared" }).step(triage).output(z.object({ url: z.string() })).build();
type _declared = Assert<Equals<typeof declared, BuiltWorkflow<any, { url: string }>>>;

// Long flows stay within the type-instantiation depth.
Agent({ id: "long" })
  .step(triage).step(planner).step(triage).step(planner).step(triage)
  .step(planner).step(triage).step(planner).step(triage).step(planner)
  .step(triage).step(planner).step(triage).step(planner).step(triage);
