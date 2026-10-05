import { HarnessError } from "../../errors.js";
import { deprecate } from "../../utils/deprecate.js";

/** A child given a new step id with `.withId()`. */
export interface NamedChild {
  readonly [NAMED]: true;
  readonly run: unknown;
  readonly id: string;
}

/** One stage of a flow. Stages hold agents, tools and flows: never functions. */
export type FlowStage =
  | { readonly kind: "step"; readonly child: unknown; readonly id?: string }
  | {
      readonly kind: "switch";
      readonly cases: Readonly<Record<string, unknown>>;
      readonly id?: string;
    }
  | {
      readonly kind: "parallel";
      readonly branches: Readonly<Record<string, unknown>>;
      readonly id?: string;
    }
  | { readonly kind: "map"; readonly each: unknown; readonly id?: string }
  | {
      readonly kind: "loop";
      readonly body: unknown;
      readonly verify: unknown;
      readonly max?: number;
      readonly id?: string;
    };

export const NAMED: unique symbol = Symbol.for("nylorun.flow.named") as never;
const FLOW = Symbol.for("nylorun.flow");

export function named(run: unknown, id: string): NamedChild {
  if (typeof id !== "string" || id.length === 0)
    throw new HarnessError("configuration.invalid", ".withId() requires a non-empty id");
  return Object.freeze({ [NAMED]: true as const, run, id });
}

export function isNamedChild(value: unknown): value is NamedChild {
  return !!value && typeof value === "object" && (value as NamedChild)[NAMED] === true;
}

// ── Stage constructors: check each call's own arguments immediately ──────────

type Options = Readonly<Record<string, unknown>> | undefined;

const HINTS: Readonly<Record<string, string>> = {
  over: "A map runs over the previous output: an array, or its `items` field.",
  from: "Each stage gets the previous stage's output.",
  as: "Use { id } to name a step.",
  name: "Use { id } to name a stage.",
  default: "Put default among the cases: .switch({ ...cases, default }).",
};

/** Function options that flows no longer take, and what replaces each (see MIGRATION.md). */
const REMOVED: Readonly<Record<string, string>> = {
  input:
    "stages get the previous output; return what the next stage needs from the previous agent's output schema",
  on: "switch reads the previous output: a string or its `route` field",
  decide: "removed; the loop retries with the verifier's feedback until max",
};

function checkOptions(method: string, options: Options, allowed: readonly string[]): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new HarnessError("configuration.invalid", `${method} options must be an object`);
  for (const key of Object.keys(options)) {
    if (allowed.includes(key)) continue;
    if (REMOVED[key])
      throw new HarnessError(
        "configuration.invalid",
        `${method} no longer takes '${key}': ${REMOVED[key]} (see MIGRATION.md).`
      );
    const hint = HINTS[key] ? ` ${HINTS[key]}` : "";
    throw new HarnessError(
      "configuration.invalid",
      `Unknown option '${key}' for ${method}. Allowed: ${allowed.join(", ")}.${hint}`
    );
  }
  if (options.id !== undefined && (typeof options.id !== "string" || options.id.length === 0))
    throw new HarnessError("configuration.invalid", `${method} id must be a non-empty string`);
}

function requireChild(method: string, child: unknown): void {
  if (child === undefined || child === null)
    throw new HarnessError("configuration.invalid", `${method} requires an agent, tool or flow()`);
  if (typeof child === "function")
    throw new HarnessError(
      "configuration.invalid",
      `${method} takes an agent, tool or flow(), not a function: flows run no code (see MIGRATION.md)`
    );
}

function requireRecord(method: string, label: string, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0)
    throw new HarnessError("configuration.invalid", `${method} requires a non-empty object of ${label}`);
  for (const [name, child] of Object.entries(value)) requireChild(`${method} '${name}'`, child);
  return value as Readonly<Record<string, unknown>>;
}

function idOf(options: Options): { id?: string } {
  return options?.id === undefined ? {} : { id: options.id as string };
}

/** `.pipe(a, b, c)`: one stage per child, in order. */
export function pipeStages(children: readonly unknown[]): FlowStage[] {
  if (children.length === 0)
    throw new HarnessError("configuration.invalid", ".pipe() requires at least one agent, tool or flow()");
  return children.map((child) => {
    requireChild(".pipe()", child);
    return Object.freeze({ kind: "step" as const, child });
  });
}

/** `.step(child, { id })`: deprecated, the same as `.pipe(child.withId(id))`. */
export function stepStage(child: unknown, options?: Options): FlowStage {
  deprecate("NYLORUN_DEP_STEP", ".step() is deprecated. Use .pipe().");
  checkOptions(".step()", options, ["id"]);
  requireChild(".step()", child);
  return Object.freeze({ kind: "step" as const, child, ...idOf(options) });
}

export function switchStage(cases: unknown, options?: Options): FlowStage {
  checkOptions(".switch()", options, ["id"]);
  const record = requireRecord(".switch()", "cases", cases);
  return Object.freeze({ kind: "switch" as const, cases: Object.freeze({ ...record }), ...idOf(options) });
}

export function parallelStage(branches: unknown, options?: Options): FlowStage {
  checkOptions(".parallel()", options, ["id"]);
  const record = requireRecord(".parallel()", "branches", branches);
  return Object.freeze({ kind: "parallel" as const, branches: Object.freeze({ ...record }), ...idOf(options) });
}

export function mapStage(each: unknown, options?: Options): FlowStage {
  checkOptions(".map()", options, ["id"]);
  requireChild(".map()", each);
  return Object.freeze({ kind: "map" as const, each, ...idOf(options) });
}

export function loopStage(body: unknown, options?: Options): FlowStage {
  checkOptions(".loop()", options, ["verify", "max", "id"]);
  requireChild(".loop()", body);
  if (options?.verify === undefined)
    throw new HarnessError("configuration.invalid", ".loop() requires { verify }: a verifier agent");
  if (typeof options.verify === "function")
    throw new HarnessError(
      "configuration.invalid",
      ".loop() no longer takes a verify function: use a verifier agent (an HTTP verifier is coming) (see MIGRATION.md)."
    );
  return Object.freeze({
    kind: "loop" as const,
    body,
    verify: options.verify,
    ...(options.max === undefined ? {} : { max: options.max as number }),
    ...idOf(options),
  });
}

// ── flow(): a sequence with no id ────────────────────────────────────────────

/**
 * A sequence of stages with no id, for a switch case, parallel branch, map item or
 * loop body that is more than one step. It has the same stage methods as a flow agent.
 */
export class FlowBuilder {
  readonly #stages: readonly FlowStage[];

  constructor(stages: readonly FlowStage[] = []) {
    this.#stages = Object.freeze([...stages]);
    Object.defineProperty(this, FLOW, { value: true });
  }

  /** @internal The stages, in order. */
  get stages(): readonly FlowStage[] {
    return this.#stages;
  }

  pipe(...children: unknown[]): FlowBuilder {
    return new FlowBuilder([...this.#stages, ...pipeStages(children)]);
  }

  /** @deprecated Use `.pipe()`. */
  step(child: unknown, options?: Options): FlowBuilder {
    return new FlowBuilder([...this.#stages, stepStage(child, options)]);
  }

  switch(cases: unknown, options?: Options): FlowBuilder {
    return new FlowBuilder([...this.#stages, switchStage(cases, options)]);
  }

  parallel(branches: unknown, options?: Options): FlowBuilder {
    return new FlowBuilder([...this.#stages, parallelStage(branches, options)]);
  }

  map(each: unknown, options?: Options): FlowBuilder {
    return new FlowBuilder([...this.#stages, mapStage(each, options)]);
  }

  loop(body: unknown, options?: Options): FlowBuilder {
    return new FlowBuilder([...this.#stages, loopStage(body, options)]);
  }

  /** Give this sequence a step id where there is no options object. */
  withId(id: string): NamedChild {
    return named(this, id);
  }
}

export function isFlowBuilder(value: unknown): value is FlowBuilder {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[FLOW] === true;
}
