/**
 * Types for flow agents: each stage's output types the next stage's `input`, and
 * `results` gains an entry for every step whose id is known at compile time.
 */
import type { SandboxManifest, AgentManifest } from "../../types/manifest.js";
import type { SchemaOutput, ToolSchemaSource } from "../../types/tool.js";
import type { Verdict } from "../../types/workflow.js";
import type { BuiltWorkflow } from "../workflow/types.js";

/** What every flow function receives. */
export type StageArgs<Cur = any, Results = Readonly<Record<string, any>>, In = any> = {
  readonly input: Cur;
  readonly results: Results;
  /** The input of the nearest Agent. */
  readonly flowInput: In;
};

/** What a function inside a nested `flow()` receives: the same as a top-level stage. */
export type NestedStageArgs<Cur = any, Results = Readonly<Record<string, any>>> = StageArgs<
  Cur,
  Results,
  any
>;

/** A child renamed with `.withId()`. */
export interface Named<R = unknown> {
  readonly run: R;
  readonly id: string;
  readonly __output?: FlowOut<R>;
}

/** The output type a flow child produces: `any` when nothing declares it. */
export type FlowOut<C> = C extends { readonly __output?: infer O }
  ? unknown extends O
    ? any
    : O
  : C extends BuiltWorkflow<any, infer O>
    ? O
    : any;

/** A child's step id, when it is a string literal. */
export type IdOf<C> = C extends { readonly __id?: infer I }
  ? I extends string
    ? I
    : string
  : string;

export type AddResult<Results, K extends string, V> = string extends K
  ? Results
  : Results & { readonly [P in K]: V };

/** Case names `on` may return: any string when there is a `default` case. */
export type CaseKey<Cases> = "default" extends keyof Cases
  ? string
  : Extract<keyof Cases, string>;

export type CasesOut<Cases> = { [K in keyof Cases]: FlowOut<Cases[K]> }[keyof Cases];

export type BranchesOut<Branches> = { readonly [K in keyof Branches]: FlowOut<Branches[K]> };

export type LoopVerifyFn<Cur, Out> = (args: {
  readonly input: Cur;
  readonly output: Out;
  readonly iteration: number;
  readonly results: Readonly<Record<string, any>>;
  readonly flowInput: any;
}) => Verdict | Promise<Verdict>;

export type LoopDecideArgs<Cur, Out> = {
  readonly input: Cur;
  readonly output: Out;
  readonly verdict: Verdict;
  readonly iteration: number;
  readonly history: readonly {
    readonly iteration: number;
    readonly output: Out;
    readonly verdict: Verdict;
  }[];
  /** The body agent's manifest, when the body is an agent: pass a variant back in `agent`. */
  readonly agent?: AgentManifest;
  readonly results: Readonly<Record<string, any>>;
  readonly flowInput: any;
};

export type LoopChoice<Out> =
  | { readonly output: Out }
  | { readonly retry: unknown; readonly agent?: AgentManifest };

type Final<Cur, Out> = [Out] extends [never] ? Cur : Out;

/**
 * A flow agent: an `Agent` whose body is a flow. Returned by `.input()` and by every
 * stage method, so ReAct methods such as `.instructions()` are not available on it.
 */
export interface FlowAgentBuilder<
  Info = unknown,
  In = any,
  Cur = any,
  Results = {},
  Out = never,
  Id extends string = string,
> extends BuiltWorkflow<In, Final<Cur, Out>> {
  readonly id: Id;
  /** Phantom carrier for the agent's id. */
  readonly __id?: Id;
  /** Phantom carrier for the context type hooks see. */
  readonly __info?: Info;
  build(): BuiltWorkflow<In, Final<Cur, Out>>;
  /** Give this flow agent a new step id where there is no options object. */
  withId(id: string): Named<this>;
  output<S extends ToolSchemaSource>(schema: S): FlowAgentBuilder<Info, In, Cur, Results, SchemaOutput<S>, Id>;
  /** The one sandbox every agent in the flow shares. */
  sandbox(spec?: SandboxManifest): FlowAgentBuilder<Info, In, Cur, Results, Out, Id>;

  step<C, const StepId extends string = IdOf<C>>(
    child: C,
    options?: { readonly id?: StepId; readonly input?: (args: StageArgs<Cur, Results, In>) => unknown }
  ): FlowAgentBuilder<Info, In, FlowOut<C>, AddResult<Results, StepId, FlowOut<C>>, Out, Id>;

  switch<const Cases extends Readonly<Record<string, unknown>>, T, const StageId extends string = string>(
    cases: Cases,
    options: {
      readonly input: (args: StageArgs<Cur, Results, In>) => T;
      readonly on: (args: StageArgs<T, Results, In>) => CaseKey<Cases>;
      readonly id?: StageId;
    }
  ): FlowAgentBuilder<Info, In, CasesOut<Cases>, AddResult<Results, StageId, CasesOut<Cases>>, Out, Id>;
  switch<const Cases extends Readonly<Record<string, unknown>>, const StageId extends string = string>(
    cases: Cases,
    options: {
      readonly on: (args: StageArgs<Cur, Results, In>) => CaseKey<Cases>;
      readonly id?: StageId;
    }
  ): FlowAgentBuilder<Info, In, CasesOut<Cases>, AddResult<Results, StageId, CasesOut<Cases>>, Out, Id>;

  parallel<const Branches extends Readonly<Record<string, unknown>>, const StageId extends string = string>(
    branches: Branches,
    options?: { readonly id?: StageId; readonly input?: (args: StageArgs<Cur, Results, In>) => unknown }
  ): FlowAgentBuilder<Info, In, BranchesOut<Branches>, AddResult<Results, StageId, BranchesOut<Branches>>, Out, Id>;

  map<E, const StageId extends string = string>(
    each: E,
    ...options: Cur extends readonly unknown[]
      ? [options?: { readonly id?: StageId; readonly input?: (args: StageArgs<Cur, Results, In>) => readonly unknown[] }]
      : [options: { readonly id?: StageId; readonly input: (args: StageArgs<Cur, Results, In>) => readonly unknown[] }]
  ): FlowAgentBuilder<Info, In, FlowOut<E>[], AddResult<Results, StageId, FlowOut<E>[]>, Out, Id>;

  loop<B, const StageId extends string = string>(
    body: B,
    options: {
      readonly verify: LoopVerifyFn<Cur, FlowOut<B>> | object;
      readonly max?: number;
      readonly decide?: (args: LoopDecideArgs<Cur, FlowOut<B>>) => LoopChoice<FlowOut<B>>;
      readonly id?: StageId;
      readonly input?: (args: StageArgs<Cur, Results, In>) => unknown;
    }
  ): FlowAgentBuilder<Info, In, FlowOut<B>, AddResult<Results, StageId, FlowOut<B>>, Out, Id>;
}

/**
 * A `flow()`: a sequence with no id, for a switch case, parallel branch, map item or
 * loop body that is more than one step.
 */
export interface Flow<Cur = any, Results = {}> {
  readonly __output?: Cur;
  withId(id: string): Named<this>;

  step<C, const StepId extends string = IdOf<C>>(
    child: C,
    options?: { readonly id?: StepId; readonly input?: (args: NestedStageArgs<Cur, Results>) => unknown }
  ): Flow<FlowOut<C>, AddResult<Results, StepId, FlowOut<C>>>;

  switch<const Cases extends Readonly<Record<string, unknown>>, T, const StageId extends string = string>(
    cases: Cases,
    options: {
      readonly input: (args: NestedStageArgs<Cur, Results>) => T;
      readonly on: (args: NestedStageArgs<T, Results>) => CaseKey<Cases>;
      readonly id?: StageId;
    }
  ): Flow<CasesOut<Cases>, AddResult<Results, StageId, CasesOut<Cases>>>;
  switch<const Cases extends Readonly<Record<string, unknown>>, const StageId extends string = string>(
    cases: Cases,
    options: { readonly on: (args: NestedStageArgs<Cur, Results>) => CaseKey<Cases>; readonly id?: StageId }
  ): Flow<CasesOut<Cases>, AddResult<Results, StageId, CasesOut<Cases>>>;

  parallel<const Branches extends Readonly<Record<string, unknown>>, const StageId extends string = string>(
    branches: Branches,
    options?: { readonly id?: StageId; readonly input?: (args: NestedStageArgs<Cur, Results>) => unknown }
  ): Flow<BranchesOut<Branches>, AddResult<Results, StageId, BranchesOut<Branches>>>;

  map<E, const StageId extends string = string>(
    each: E,
    ...options: Cur extends readonly unknown[]
      ? [options?: { readonly id?: StageId; readonly input?: (args: NestedStageArgs<Cur, Results>) => readonly unknown[] }]
      : [options: { readonly id?: StageId; readonly input: (args: NestedStageArgs<Cur, Results>) => readonly unknown[] }]
  ): Flow<FlowOut<E>[], AddResult<Results, StageId, FlowOut<E>[]>>;

  loop<B, const StageId extends string = string>(
    body: B,
    options: {
      readonly verify: LoopVerifyFn<Cur, FlowOut<B>> | object;
      readonly max?: number;
      readonly decide?: (args: LoopDecideArgs<Cur, FlowOut<B>>) => LoopChoice<FlowOut<B>>;
      readonly id?: StageId;
      readonly input?: (args: NestedStageArgs<Cur, Results>) => unknown;
    }
  ): Flow<FlowOut<B>, AddResult<Results, StageId, FlowOut<B>>>;
}
