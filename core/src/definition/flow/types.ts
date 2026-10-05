/**
 * Types for flow agents: each stage's output types the next stage's input, and the last
 * stage's output is the flow agent's.
 */
import type { SchemaOutput, ToolSchemaSource } from "../../types/tool.js";
import type { BuiltWorkflow } from "../workflow/types.js";

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

/** The output of the last of `.pipe()`'s children. */
export type PipeOut<Children extends readonly unknown[], Cur> = Children extends readonly [
  ...unknown[],
  infer Last,
]
  ? FlowOut<Last>
  : Cur;

export type CasesOut<Cases> = { [K in keyof Cases]: FlowOut<Cases[K]> }[keyof Cases];

export type BranchesOut<Branches> = { readonly [K in keyof Branches]: FlowOut<Branches[K]> };

/** `.loop()` options: a verifier agent judges each attempt, at most `max` times. */
export interface LoopOptions {
  /** The verifier agent. It gets `{ task, response, iteration }` and returns a verdict. */
  readonly verify: object;
  readonly max: number;
  readonly id?: string;
}

/** Options every other stage takes. */
export interface StageOptions {
  readonly id?: string;
}

type Final<Cur, Out> = [Out] extends [never] ? Cur : Out;

/**
 * A flow agent: an `Agent` whose body is a flow. Returned by `.input()` and by every
 * stage method, so ReAct methods such as `.instructions()` are not available on it.
 */
export interface FlowAgentBuilder<
  Info = unknown,
  In = any,
  Cur = any,
  Out = never,
  Id extends string = string,
> extends BuiltWorkflow<In, Final<Cur, Out>> {
  readonly id: Id;
  /** Phantom carrier for the agent's id. */
  readonly __id?: Id;
  /** Phantom carrier for the agent's context type. */
  readonly __info?: Info;
  build(): BuiltWorkflow<In, Final<Cur, Out>>;
  /** Give this flow agent a new step id where there is no options object. */
  withId(id: string): Named<this>;
  output<S extends ToolSchemaSource>(schema: S): FlowAgentBuilder<Info, In, Cur, SchemaOutput<S>, Id>;

  /** Add stages in order: each gets the previous one's output. */
  pipe<const Children extends readonly unknown[]>(
    ...children: Children
  ): FlowAgentBuilder<Info, In, PipeOut<Children, Cur>, Out, Id>;

  /** @deprecated Use `.pipe()`, and `.withId()` to rename a child. */
  step<C>(child: C, options?: StageOptions): FlowAgentBuilder<Info, In, FlowOut<C>, Out, Id>;

  switch<const Cases extends Readonly<Record<string, unknown>>>(
    cases: Cases,
    options?: StageOptions
  ): FlowAgentBuilder<Info, In, CasesOut<Cases>, Out, Id>;

  parallel<const Branches extends Readonly<Record<string, unknown>>>(
    branches: Branches,
    options?: StageOptions
  ): FlowAgentBuilder<Info, In, BranchesOut<Branches>, Out, Id>;

  map<E>(each: E, options?: StageOptions): FlowAgentBuilder<Info, In, FlowOut<E>[], Out, Id>;

  loop<B>(body: B, options: LoopOptions): FlowAgentBuilder<Info, In, FlowOut<B>, Out, Id>;
}

/**
 * A `flow()`: a sequence with no id, for a switch case, parallel branch, map item or
 * loop body that is more than one step.
 */
export interface Flow<Cur = any> {
  readonly __output?: Cur;
  withId(id: string): Named<this>;

  pipe<const Children extends readonly unknown[]>(
    ...children: Children
  ): Flow<PipeOut<Children, Cur>>;

  /** @deprecated Use `.pipe()`, and `.withId()` to rename a child. */
  step<C>(child: C, options?: StageOptions): Flow<FlowOut<C>>;

  switch<const Cases extends Readonly<Record<string, unknown>>>(
    cases: Cases,
    options?: StageOptions
  ): Flow<CasesOut<Cases>>;

  parallel<const Branches extends Readonly<Record<string, unknown>>>(
    branches: Branches,
    options?: StageOptions
  ): Flow<BranchesOut<Branches>>;

  map<E>(each: E, options?: StageOptions): Flow<FlowOut<E>[]>;

  loop<B>(body: B, options: LoopOptions): Flow<FlowOut<B>>;
}
