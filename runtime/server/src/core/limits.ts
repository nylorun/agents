/**
 * Operator flow limits (`workflows.md` §13).
 * Host configuration only — never workflow API settings.
 */

export type FlowLimits = {
  readonly maxConcurrency: number;
  readonly maxMapItems: number;
  readonly maxLoopIterations: number;
};

export const FLOW_LIMIT_DEFAULTS: FlowLimits = {
  maxConcurrency: 8,
  maxMapItems: 1000,
  maxLoopIterations: 100,
};

export const FLOW_LIMIT_ENV = {
  maxConcurrency: "NYLORUN_FLOW_MAX_CONCURRENCY",
  maxMapItems: "NYLORUN_FLOW_MAX_MAP_ITEMS",
  maxLoopIterations: "NYLORUN_FLOW_MAX_LOOP_ITERATIONS",
} as const;

export type FlowLimitErrorCode = "map.too-many-items" | "loop.too-many-iterations";

export class FlowLimitError extends Error {
  readonly code: FlowLimitErrorCode;
  readonly path?: string;
  constructor(code: FlowLimitErrorCode, message: string, path?: string) {
    super(message);
    this.name = "FlowLimitError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

function parsePositiveInt(
  raw: string | undefined,
  field: string
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0)
    throw new Error(`${field} must be a positive integer`);
  return n;
}

/**
 * Resolve limits from `RuntimeOptions.flow` overrides and optional env snapshot.
 * Does not read ambient process environment — callers pass an explicit env map.
 */
export function resolveFlowLimits(input?: {
  readonly flow?: Partial<FlowLimits> | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): FlowLimits {
  const env = input?.env ?? {};
  const flow = input?.flow ?? {};
  const fromEnv = {
    maxConcurrency: parsePositiveInt(
      env[FLOW_LIMIT_ENV.maxConcurrency],
      FLOW_LIMIT_ENV.maxConcurrency
    ),
    maxMapItems: parsePositiveInt(
      env[FLOW_LIMIT_ENV.maxMapItems],
      FLOW_LIMIT_ENV.maxMapItems
    ),
    maxLoopIterations: parsePositiveInt(
      env[FLOW_LIMIT_ENV.maxLoopIterations],
      FLOW_LIMIT_ENV.maxLoopIterations
    ),
  };
  const pick = (
    field: keyof FlowLimits,
    override: number | undefined,
    envValue: number | undefined
  ): number => {
    const value = override ?? envValue ?? FLOW_LIMIT_DEFAULTS[field];
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
      throw new Error(`flow.${field} must be a positive integer`);
    return value;
  };
  return {
    maxConcurrency: pick(
      "maxConcurrency",
      flow.maxConcurrency,
      fromEnv.maxConcurrency
    ),
    maxMapItems: pick("maxMapItems", flow.maxMapItems, fromEnv.maxMapItems),
    maxLoopIterations: pick(
      "maxLoopIterations",
      flow.maxLoopIterations,
      fromEnv.maxLoopIterations
    ),
  };
}

/** Further ready work waits when active >= maxConcurrency (not an error). */
export function mayDispatchMore(
  activeCount: number,
  limits: Pick<FlowLimits, "maxConcurrency">
): boolean {
  return activeCount < limits.maxConcurrency;
}

/**
 * Map item ceiling. Exceeding raises `map.too-many-items` and nothing should start.
 */
export function assertMapItemCount(
  count: number,
  limits: Pick<FlowLimits, "maxMapItems">,
  path?: string
): void {
  if (count > limits.maxMapItems)
    throw new FlowLimitError(
      "map.too-many-items",
      `Map produced ${count} items; maxMapItems is ${limits.maxMapItems}`,
      path
    );
}

/**
 * Loop operator ceiling. Exceeding raises `loop.too-many-iterations`.
 * `n` is the 1-based iteration about to run.
 */
export function assertLoopIteration(
  n: number,
  limits: Pick<FlowLimits, "maxLoopIterations">,
  path?: string
): void {
  if (n > limits.maxLoopIterations)
    throw new FlowLimitError(
      "loop.too-many-iterations",
      `Loop iteration ${n} exceeds maxLoopIterations ${limits.maxLoopIterations}`,
      path
    );
}
