import { HarnessError } from "../../errors.js";

/** A function in a flow stage: `input`, `on`, `verify` or `decide`. */
export type FlowFn = (args: any) => unknown;

/** A child given a new step id with `.withId()`. */
export interface NamedChild {
  readonly [NAMED]: true;
  readonly run: unknown;
  readonly id: string;
}

export type FlowStage =
  | {
      readonly kind: "step";
      readonly child: unknown;
      readonly id?: string;
      readonly input?: FlowFn;
    }
  | {
      readonly kind: "switch";
      readonly cases: Readonly<Record<string, unknown>>;
      readonly on: FlowFn;
      readonly id?: string;
      readonly input?: FlowFn;
    }
  | {
      readonly kind: "parallel";
      readonly branches: Readonly<Record<string, unknown>>;
      readonly id?: string;
      readonly input?: FlowFn;
    }
  | {
      readonly kind: "map";
      readonly each: unknown;
      readonly id?: string;
      readonly input?: FlowFn;
    }
  | {
      readonly kind: "loop";
      readonly body: unknown;
      readonly verify: unknown;
      readonly max?: number;
      readonly decide?: FlowFn;
      readonly id?: string;
      readonly input?: FlowFn;
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
  over: "A Map runs over its input. Use { input: ({ input }) => list } to pick the list.",
  from: "Use { input } to compute a step's input.",
  as: "Use { id } to name a step.",
  name: "Use { id } to name a stage.",
  default: "Put default among the cases: .switch({ ...cases, default }, { on }).",
};

function checkOptions(method: string, options: Options, allowed: readonly string[]): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new HarnessError("configuration.invalid", `${method} options must be an object`);
  for (const key of Object.keys(options)) {
    if (allowed.includes(key)) continue;
    const hint = HINTS[key] ? ` ${HINTS[key]}` : "";
    throw new HarnessError(
      "configuration.invalid",
      `Unknown option '${key}' for ${method}. Allowed: ${allowed.join(", ")}.${hint}`
    );
  }
  if (options.id !== undefined && (typeof options.id !== "string" || options.id.length === 0))
    throw new HarnessError("configuration.invalid", `${method} id must be a non-empty string`);
  if (options.input !== undefined && typeof options.input !== "function")
    throw new HarnessError("configuration.invalid", `${method} input must be a function`);
}

function requireChild(method: string, child: unknown): void {
  if (child === undefined || child === null)
    throw new HarnessError("configuration.invalid", `${method} requires an agent, tool or flow()`);
}

function requireRecord(method: string, label: string, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0)
    throw new HarnessError("configuration.invalid", `${method} requires a non-empty object of ${label}`);
  return value as Readonly<Record<string, unknown>>;
}

function common(options: Options): { id?: string; input?: FlowFn } {
  return {
    ...(options?.id === undefined ? {} : { id: options.id as string }),
    ...(options?.input === undefined ? {} : { input: options.input as FlowFn }),
  };
}

export function stepStage(child: unknown, options?: Options): FlowStage {
  checkOptions(".step()", options, ["id", "input"]);
  requireChild(".step()", child);
  return Object.freeze({ kind: "step" as const, child, ...common(options) });
}

export function switchStage(cases: unknown, options?: Options): FlowStage {
  checkOptions(".switch()", options, ["on", "id", "input"]);
  const record = requireRecord(".switch()", "cases", cases);
  if (typeof options?.on !== "function")
    throw new HarnessError(
      "configuration.invalid",
      ".switch() requires { on: ({ input }) => caseName }"
    );
  return Object.freeze({
    kind: "switch" as const,
    cases: Object.freeze({ ...record }),
    on: options.on as FlowFn,
    ...common(options),
  });
}

export function parallelStage(branches: unknown, options?: Options): FlowStage {
  checkOptions(".parallel()", options, ["id", "input"]);
  const record = requireRecord(".parallel()", "branches", branches);
  return Object.freeze({ kind: "parallel" as const, branches: Object.freeze({ ...record }), ...common(options) });
}

export function mapStage(each: unknown, options?: Options): FlowStage {
  checkOptions(".map()", options, ["id", "input"]);
  requireChild(".map()", each);
  return Object.freeze({ kind: "map" as const, each, ...common(options) });
}

export function loopStage(body: unknown, options?: Options): FlowStage {
  checkOptions(".loop()", options, ["verify", "max", "decide", "id", "input"]);
  requireChild(".loop()", body);
  if (options?.verify === undefined)
    throw new HarnessError("configuration.invalid", ".loop() requires { verify }: a function or a verifier agent");
  if (options.decide !== undefined && typeof options.decide !== "function")
    throw new HarnessError("configuration.invalid", ".loop() decide must be a function");
  return Object.freeze({
    kind: "loop" as const,
    body,
    verify: options.verify,
    ...(options.max === undefined ? {} : { max: options.max as number }),
    ...(options.decide === undefined ? {} : { decide: options.decide as FlowFn }),
    ...common(options),
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
