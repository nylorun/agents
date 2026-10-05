/**
 * Compile-time tests for flow agents: each stage's output types the next stage's input, the
 * last stage's output types the flow agent's, and function options are type errors.
 * Run via: tsc -p test/workflow/types/tsconfig.json
 */
import { z } from "zod";
import { Agent, flow, tool, VerdictSchema, type BuiltWorkflow } from "../../../src/define.js";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

const triage = Agent({ id: "triage" })
  .instructions("Classify.")
  .output(z.object({ route: z.enum(["bug", "docs", "feature"]), summary: z.string() }));
const planner = Agent({ id: "planner" }).instructions("Plan.").output(z.object({ items: z.array(z.string()) }));
const implementer = Agent({ id: "implementer" }).instructions("Implement.");
const fixer = Agent({ id: "fixer" }).instructions("Fix.");
const general = Agent({ id: "general" }).instructions("Answer.");
const judge = Agent({ id: "judge" }).instructions("Judge.").output(VerdictSchema);
const security = Agent({ id: "security" }).instructions("Review.").output(z.object({ score: z.number() }));
const style = Agent({ id: "style" }).instructions("Review.").output(z.object({ score: z.number() }));
const openPr = tool({
  name: "open_pr",
  input: z.object({ title: z.string() }),
  async run({ title }) {
    return title;
  },
});

// The build is a workflow typed by its last stage, or by .output().
const piped = Agent({ id: "piped" }).pipe(triage, planner).build();
type _piped = Assert<Equals<typeof piped, BuiltWorkflow<any, { items: string[] }>>>;
const declared = Agent({ id: "declared" }).pipe(triage).output(z.object({ url: z.string() })).build();
type _declared = Assert<Equals<typeof declared, BuiltWorkflow<any, { url: string }>>>;

// Parallel output is keyed by branch.
const reviews = Agent({ id: "reviews" }).parallel({ security, style }).build();
type _reviews = Assert<
  Equals<typeof reviews, BuiltWorkflow<any, { readonly security: { score: number }; readonly style: { score: number } }>>
>;

// A map's output is a list of its child's outputs; a loop's is its body's.
const mapped = Agent({ id: "mapped" }).pipe(planner).map(security).build();
type _mapped = Assert<Equals<typeof mapped, BuiltWorkflow<any, { score: number }[]>>>;
const looped = Agent({ id: "looped" }).loop(planner, { verify: judge, max: 3 }).build();
type _looped = Assert<Equals<typeof looped, BuiltWorkflow<any, { items: string[] }>>>;

// Switch cases and the default; no `on`.
Agent({ id: "route" }).pipe(triage).switch({ bug: fixer, docs: general, default: implementer }, { id: "route" });
// @ts-expect-error switch reads the previous output: there is no `on`
Agent({ id: "on" }).pipe(triage).switch({ bug: fixer }, { on: () => "bug" });

// Stages take no `input` function.
// @ts-expect-error stages get the previous output
Agent({ id: "input" }).pipe(triage).map(implementer, { input: () => [] });

// A loop needs a verifier and max, and takes no `decide`.
// @ts-expect-error max is required
Agent({ id: "nomax" }).loop(fixer, { verify: judge });
// @ts-expect-error decide was removed
Agent({ id: "decide" }).loop(fixer, { verify: judge, max: 2, decide: () => ({ output: 1 }) });

// A flow agent has no ReAct methods.
// @ts-expect-error flow agents run no model
Agent({ id: "flow" }).pipe(triage).instructions("x");

// flow() sequences type their own stages.
const sequence = flow().pipe(triage, planner);
type _sequence = Assert<Equals<NonNullable<typeof sequence.__output>, { items: string[] }>>;
Agent({ id: "ship" }).pipe(sequence, openPr);

// Long flows stay within the type-instantiation depth.
Agent({ id: "long" })
  .pipe(triage, planner, triage, planner, triage)
  .pipe(planner).pipe(triage).pipe(planner).pipe(triage).pipe(planner)
  .pipe(triage).pipe(planner).pipe(triage).pipe(planner).pipe(triage);
