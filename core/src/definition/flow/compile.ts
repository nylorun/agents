/**
 * Compile a flow agent's stages to today's workflow primitives (WorkflowManifest v1).
 *
 * Phase 1 of Flow Agents: the new syntax changes, the wire does not. Stages become
 * `Chain`, `Switch`, `Parallel`, `Map` and `Loop` nodes plus slots; user functions
 * receive `{ input, results, flowInput }` and are adapted to the shapes the flow
 * engine passes today.
 */
import type { JsonValue, JsonObject, BuildDiagnostic } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import type { SandboxManifest } from "../../types/manifest.js";
import type { WorkflowManifest } from "../../types/workflow.js";
import { canonical } from "../../utils/canonical.js";
import { Chain } from "../workflow/chain.js";
import { Switch } from "../workflow/switch.js";
import { Parallel } from "../workflow/parallel.js";
import { Map as MapNode } from "../workflow/map.js";
import { Loop } from "../workflow/loop.js";
import { isSlot, type ChildRef, type Slot } from "../workflow/slot.js";
import { diagnostic, fail } from "../workflow/diagnostics.js";
import type { BuiltWorkflow } from "../workflow/types.js";
import {
  isFlowBuilder,
  isNamedChild,
  type FlowFn,
  type FlowStage,
} from "./spec.js";

/** The value a Switch envelope carries between its `input` slot and its cases. */
const ENVELOPE = "__nylorunSwitch";

type Ctx = { readonly nested: boolean };

type SlotArgs = {
  readonly value: JsonValue;
  readonly input: JsonValue;
  readonly results: Readonly<Record<string, JsonValue>>;
};

export interface CompileFlowOptions {
  readonly id: string;
  readonly stages: readonly FlowStage[];
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
  readonly sandbox?: SandboxManifest;
}

/** Compile a flow agent. Throws `WorkflowBuildError` with diagnostics. */
export function compileAgentFlow(options: CompileFlowOptions): BuiltWorkflow {
  const stages = expand(options.stages);
  if (stages.length === 0)
    fail([
      diagnostic(
        "flow.empty",
        `Flow agent '${options.id}' has no stages. Add .step(), .switch(), .parallel(), .map() or .loop().`
      ),
    ]);
  const schemas = {
    ...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  };
  const root: Ctx = { nested: false };
  const only = stages.length === 1 ? stages[0]! : undefined;
  // One unnamed control stage is the whole agent: it compiles to that node, with the
  // agent's id, exactly like today's `Loop({ id, … })`.
  const built =
    only && only.kind !== "step" && only.kind !== "switch" && only.id === undefined && only.input === undefined
      ? compileControl(only, options.id, root, schemas)
      : only && only.kind === "switch" && only.id === undefined && only.input === undefined
        ? (compileSwitch(only, options.id, true, root, schemas) as BuiltWorkflow)
        : Chain({
            id: options.id,
            steps: stages.map((stage, index) => compileStage(stage, index + 1, root)) as never,
            ...schemas,
          } as never);
  return options.sandbox === undefined ? built : withFlowSandbox(built, options.id, options.sandbox);
}

/** Inline `.step(flow())` sequences that have no id or input into their parent. */
function expand(stages: readonly FlowStage[]): FlowStage[] {
  const out: FlowStage[] = [];
  for (const stage of stages) {
    if (
      stage.kind === "step" &&
      isFlowBuilder(stage.child) &&
      stage.id === undefined &&
      stage.input === undefined
    )
      out.push(...expand(stage.child.stages));
    else out.push(stage);
  }
  return out;
}

function compileStage(stage: FlowStage, position: number, ctx: Ctx): ChildRef {
  if (stage.kind === "step") {
    let ref = childRef(stage.child, stage.id ?? `flow-${position}`, ctx);
    if (stage.id !== undefined) ref = rename(ref, stage.id);
    if (stage.input) ref = withInput(ref, adaptInput(stage.input, ctx), stage.id ?? `step-${position}`);
    return ref;
  }
  const id = stage.id ?? `${stage.kind}-${position}`;
  if (stage.kind === "switch") return compileSwitch(stage, id, position === 1, ctx);
  const node = compileControl(stage, id, ctx);
  return stage.input ? withInput(node, adaptInput(stage.input, ctx), id) : node;
}

function compileControl(
  stage: Exclude<FlowStage, { kind: "step" } | { kind: "switch" }>,
  id: string,
  ctx: Ctx,
  schemas: { inputSchema?: ToolSchemaSource; outputSchema?: ToolSchemaSource } = {}
): BuiltWorkflow {
  switch (stage.kind) {
    case "parallel":
      return Parallel({
        id,
        branches: mapValues(stage.branches, (child, key) => childRef(child, key, ctx)),
        ...schemas,
      } as never);
    case "map":
      // A Map runs over its input: the list comes from the stage's `input`, or is
      // the previous step's output. A non-array fails with `map.not-a-list`.
      return MapNode({
        id,
        over: (value: JsonValue) => value as never,
        each: childRef(stage.each, "each", ctx),
        ...schemas,
      } as never);
    case "loop":
      return compileLoop(stage, id, ctx, schemas);
  }
}

function compileLoop(
  stage: Extract<FlowStage, { kind: "loop" }>,
  id: string,
  ctx: Ctx,
  schemas: { inputSchema?: ToolSchemaSource; outputSchema?: ToolSchemaSource }
): BuiltWorkflow {
  const problems: BuildDiagnostic[] = [];
  if (stage.max !== undefined && (!Number.isInteger(stage.max) || stage.max < 1))
    problems.push(diagnostic("loop.invalid-max", `Loop '${id}' max must be a positive integer`));
  if (stage.max === undefined && stage.decide === undefined)
    problems.push(
      diagnostic(
        "loop.max-required",
        `Loop '${id}' needs { max } or { decide } so it cannot run forever`
      )
    );
  if (problems.length) fail(problems);
  const max = stage.max;
  const decide = stage.decide;
  const wrapped = (args: {
    readonly output: JsonValue;
    readonly verdict: { readonly pass: boolean; readonly feedback?: string };
    readonly iteration: number;
  }) => {
    const choice = (decide
      ? decide(args)
      : args.verdict.pass
        ? { output: args.output }
        : { retry: args.verdict.feedback ?? "" }) as Record<string, unknown> | undefined;
    if (!choice || typeof choice !== "object")
      throw new Error(`Loop '${id}' decide must return { output } or { retry }`);
    if ("output" in choice) return { output: choice.output };
    if (max !== undefined && args.iteration >= max)
      throw new Error(
        `Loop '${id}' stopped after ${max} attempt${max === 1 ? "" : "s"}` +
          (args.verdict.pass ? "" : `: ${args.verdict.feedback ?? ""}`)
      );
    if ("retry" in choice)
      return {
        input: choice.retry,
        ...(choice.agent === undefined ? {} : { agent: choice.agent }),
      };
    return choice; // `{ input, agent? }` from code written against today's Loop
  };
  const verify = typeof stage.verify === "function" ? stage.verify : childRef(stage.verify, "verify", ctx);
  return Loop({
    id,
    run: childRef(stage.body, "body", ctx),
    verify,
    decide: wrapped,
    ...schemas,
  } as never);
}

function compileSwitch(
  stage: Extract<FlowStage, { kind: "switch" }>,
  id: string,
  first: boolean,
  ctx: Ctx,
  schemas: { inputSchema?: ToolSchemaSource; outputSchema?: ToolSchemaSource } = {}
): ChildRef {
  const { default: fallback, ...cases } = stage.cases;
  // Today's engine passes `on` only the Switch's input. That is enough on the first
  // stage (no earlier results, and the flow input is the input) unless an `input`
  // function reshaped it at the root. Otherwise an envelope carries the key.
  const direct = first && (ctx.nested || !stage.input);
  if (direct) {
    const node = Switch({
      id,
      on: (raw: JsonValue) => stage.on(stageArgs(raw, {}, raw, ctx)),
      cases: mapValues(cases, (child, key) => childRef(child, key, ctx)),
      ...(fallback === undefined ? {} : { default: childRef(fallback, "default", ctx) }),
      ...schemas,
    } as never);
    return stage.input ? withInput(node, adaptInput(stage.input, ctx), id) : node;
  }
  const envelope = (args: SlotArgs) => {
    const value = stage.input
      ? (stage.input(stageArgs(args.value, args.results, args.input, ctx)) as JsonValue)
      : args.value;
    const key = stage.on(stageArgs(value, args.results, args.input, ctx));
    return { [ENVELOPE]: { key, value } };
  };
  const unwrap = (args: SlotArgs) => (args.value as JsonObject)[ENVELOPE] &&
    ((args.value as JsonObject)[ENVELOPE] as JsonObject).value;
  const caseRef = (child: unknown, key: string) => withInput(childRef(child, key, ctx), unwrap, key);
  const node = Switch({
    id,
    on: (env: JsonObject) => (env[ENVELOPE] as JsonObject).key,
    cases: mapValues(cases, caseRef),
    ...(fallback === undefined ? {} : { default: caseRef(fallback, "default") }),
    ...schemas,
  } as never);
  return { run: node, input: envelope } as Slot;
}

/** Resolve a stage child: an agent, tool, flow agent, `flow()` or `.withId()` child. */
function childRef(child: unknown, role: string, ctx: Ctx): ChildRef {
  if (isNamedChild(child)) return rename(childRef(child.run, child.id, ctx), child.id);
  if (isFlowBuilder(child)) return compileNested(child.stages, role);
  if (child === null || child === undefined || (typeof child !== "object" && typeof child !== "function"))
    fail([diagnostic("workflow.invalid-runnable", `Unsupported flow child for '${role}'`)]);
  void ctx;
  return child as ChildRef;
}

/** A `flow()`: one stage compiles to that stage, several to a Chain named by its role. */
function compileNested(stages: readonly FlowStage[], role: string): ChildRef {
  const expanded = expand(stages);
  if (expanded.length === 0)
    fail([diagnostic("flow.empty", `flow() for '${role}' has no stages`)]);
  const nested: Ctx = { nested: true };
  if (expanded.length === 1) return compileStage(expanded[0]!, 1, nested);
  return Chain({
    id: role,
    steps: expanded.map((stage, index) => compileStage(stage, index + 1, nested)) as never,
  } as never);
}

function rename(ref: ChildRef, id: string): ChildRef {
  return isSlot(ref) ? { ...ref, id } : ({ run: ref, id } as Slot);
}

/** Add an input function to a child, wrapping in a one-step Chain when it already has one. */
function withInput(ref: ChildRef, input: (args: SlotArgs) => unknown, idHint: string): ChildRef {
  if (isSlot(ref)) {
    if (ref.input)
      return {
        run: Chain({ id: ref.id ?? idHint, steps: [ref] as never } as never),
        input: input as never,
      } as Slot;
    return { ...ref, input: input as never };
  }
  return { run: ref, input: input as never } as Slot;
}

function adaptInput(fn: FlowFn, ctx: Ctx): (args: SlotArgs) => unknown {
  return (args) => fn(stageArgs(args.value, args.results, args.input, ctx));
}

/** `{ input, results, flowInput }` for a user function. */
function stageArgs(
  input: JsonValue,
  results: Readonly<Record<string, JsonValue>>,
  owner: JsonValue,
  ctx: Ctx
): Record<string, unknown> {
  const args: Record<string, unknown> = { input, results };
  if (!ctx.nested) args.flowInput = owner;
  else
    Object.defineProperty(args, "flowInput", {
      enumerable: false,
      get() {
        throw new Error(
          "flow.flow-input-nested: flowInput is not available inside a nested flow() yet. " +
            "Read it in a top-level stage of the agent and pass it along."
        );
      },
    });
  return args;
}

function mapValues<T, U>(
  record: Readonly<Record<string, T>>,
  fn: (value: T, key: string) => U
): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [key, value] of Object.entries(record)) out[key] = fn(value, key);
  return out;
}

/**
 * Declare the flow's sandbox. Until workflow manifest v2, every agent in the flow that
 * declares a sandbox must declare this same spec.
 */
function withFlowSandbox(built: BuiltWorkflow, id: string, spec: SandboxManifest): BuiltWorkflow {
  const inferred = built.manifest.sandbox;
  if (inferred !== undefined && canonical(inferred) !== canonical(spec))
    fail([
      diagnostic(
        "workflow.sandbox-mismatch",
        `Flow agent '${id}' declares a sandbox its agents do not match. Until workflow manifest v2, give each agent's .sandbox() the same spec as the flow.`
      ),
    ]);
  const manifest: WorkflowManifest = { ...built.manifest, sandbox: spec };
  const binding = Object.freeze({ ...built.getBinding(), manifest });
  const next = {
    ...built,
    manifest,
    toJSON: () => manifest,
  } as BuiltWorkflow;
  Object.defineProperty(next, "getBinding", { value: () => binding, enumerable: false });
  return next;
}
