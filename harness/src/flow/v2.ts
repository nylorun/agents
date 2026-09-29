/**
 * Flow engine for workflow manifest v2 (`flow-2`).
 *
 * Differences from v1 (`flow-1`), per the Flow Agents design:
 * - Agent and tool sessions are named by leaf paths: the leaf's id, `[i]` per Map
 *   item, under nested flow agents' ids. Control stages add nothing.
 * - Functions are bound under stage keys (`route:on`, `@1.default.1:input`) and all
 *   receive `{ input, results, flowInput }`; `flowInput` is the nearest Agent's input.
 * - Any node may carry `input`; there are no slots. A Map runs over its input.
 * - A Loop without `decide` passes on a pass verdict and retries with the feedback,
 *   up to `max` attempts; `decide` returns `{ output }` or `{ retry, agent? }`.
 * - Leaf agents come from the manifest's embedded `agents`; nested flow agents run
 *   inline with their own `flowInput` and `results`.
 */
import { HarnessError, isVariantOf } from "@nylorun/core/define";
import {
  ROOT_POSITION,
  childPosition,
  functionKey,
  indexSuffix,
  isWorkflowManifestV2,
  leafPart,
  leafPath,
  stageKey,
  type AgentManifest,
  type FlowFunctionRole,
  type JsonValue,
  type Verdict,
  type WorkflowManifestV2,
  type WorkflowNodeV2,
} from "@nylorun/core/define";
import type { DurableHost } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import {
  createFlowContext,
  failureOf,
  markFailFastCancels,
  settleInFlight,
  type FlowContext,
} from "./context.js";
import { assertLoopIteration, assertMapItemCount, type FlowOperatorLimits } from "./limits.js";
import { iterationsOf } from "./paths.js";
import { readAgentTurn } from "./loop.js";
import { FlowNodeError, type FlowDurableResult } from "./types.js";

/** Where a node runs: its flow, path prefixes, Map indices, and what its functions see. */
type Scope = {
  /** The flow agent whose `agents` resolve agent nodes here. */
  readonly manifest: WorkflowManifestV2;
  /** Nested flow agent ids from the root, for the host to find embedded leaves. */
  readonly flow: readonly string[];
  /** Leaf path prefix: the nested flow agents' paths. */
  readonly pathPrefix: string;
  /** Stage key prefix: the nested flow agents' keys. */
  readonly keyPrefix: string;
  /** Map indices not yet attached to a path part. */
  readonly pending: readonly number[];
  /** Every enclosing Map index, outermost first. */
  readonly indices: readonly number[];
  /** Enclosing Loop iteration numbers, outermost first. */
  readonly iterations: readonly number[];
  /** The nearest Agent's input. */
  readonly flowInput: JsonValue;
  /** The nearest chain's results so far. */
  readonly results: Readonly<Record<string, JsonValue>>;
};

type Decision =
  { readonly output: JsonValue } | { readonly retry: JsonValue; readonly agent?: AgentManifest };

type LoopHistoryEntry = {
  readonly iteration: number;
  readonly output: JsonValue;
  readonly verdict: Verdict;
};

/** Extra context an agent effect carries for the host (Loop number, verifier role). */
type AgentEffectOptions = {
  readonly context?: Record<string, unknown>;
  /** A Loop body's variant for this turn. */
  readonly manifest?: AgentManifest;
};

export async function runFlowV2(options: {
  manifest: WorkflowManifestV2;
  checkpoint: FlowCheckpoint;
  host: DurableHost;
  signal?: AbortSignal;
  limits?: Partial<FlowOperatorLimits> | null;
}): Promise<FlowDurableResult> {
  const { manifest, checkpoint, signal } = options;
  const ctx = createFlowContext(options);
  const scope: Scope = {
    manifest,
    flow: [],
    pathPrefix: "",
    keyPrefix: "",
    pending: [],
    indices: [],
    iterations: [],
    flowInput: checkpoint.input,
    results: {},
  };
  try {
    if (signal?.aborted)
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const output = await runNode(ctx, scope, manifest.root, ROOT_POSITION, checkpoint.input);
    return { status: "completed", checkpoint, result: { status: "completed", output } };
  } catch (error) {
    await settleInFlight(ctx);
    if (error instanceof HostSuspension)
      return {
        status: [...ctx.pending.values()].includes("uncertain") ? "uncertain" : "waiting",
        checkpoint,
        effectIds: [...ctx.pending.keys()],
      };
    if (error instanceof FlowNodeError && error.failure.code === "cancelled")
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    return {
      status: "failed",
      checkpoint,
      result: { status: "failed", error: failureOf(error, manifest.id) },
      ...(ctx.cancelEffectIds.size > 0 ? { cancelEffectIds: [...ctx.cancelEffectIds] } : {}),
    };
  }
}

/** Where a node's effects are recorded: a leaf's path, or its stage key plus Map indices. */
function siteOf(scope: Scope, node: WorkflowNodeV2, key: string): string {
  const part = leafPart(node);
  return part === undefined
    ? `${key}${indexSuffix(scope.indices)}`
    : leafPath(scope.pathPrefix, part, scope.pending);
}

async function runNode(
  ctx: FlowContext,
  scope: Scope,
  node: WorkflowNodeV2,
  position: string,
  input: JsonValue,
  agentOptions: AgentEffectOptions = {},
): Promise<JsonValue> {
  const key = stageKey(node, position, scope.keyPrefix);
  const site = siteOf(scope, node, key);
  let value = input;
  if (node.input) value = await callFn(ctx, scope, key, site, "input", stageArgs(scope, value));
  if ("agent" in node)
    return (await runAgent(ctx, scope, node, key, site, value, agentOptions)).output;
  if ("tool" in node) return runTool(ctx, scope, node.tool.name, key, site, value);
  if ("chain" in node) return runChain(ctx, scope, node.chain, position, value);
  if ("switch" in node) return runSwitch(ctx, scope, node.switch, key, site, position, value);
  if ("parallel" in node) return runParallel(ctx, scope, node.parallel, site, position, value);
  if ("map" in node) return runMap(ctx, scope, node.map.each, site, position, value);
  if ("loop" in node) return runLoop(ctx, scope, node.loop, key, site, position, value);
  throw new HarnessError("execution.invalid-state", "Unknown workflow node kind");
}

function stageArgs(scope: Scope, input: JsonValue): Record<string, JsonValue> {
  return { input, results: scope.results, flowInput: scope.flowInput };
}

async function callFn(
  ctx: FlowContext,
  scope: Scope,
  key: string,
  site: string,
  role: FlowFunctionRole,
  args: Record<string, unknown>,
  context: Record<string, unknown> = {},
): Promise<JsonValue> {
  return (await ctx.effect(
    role === "verify" ? "verify" : "fn",
    args,
    {
      path: `${site}:${role}`,
      key: functionKey(key, role),
      iterations: iterationsOf(scope.iterations),
    },
    { role, ...context },
  )) as JsonValue;
}

/**
 * An agent node: a leaf agent runs as one turn in its own session; a nested flow agent
 * runs inline, under its own id, with its own `flowInput` and `results`.
 */
async function runAgent(
  ctx: FlowContext,
  scope: Scope,
  node: Extract<WorkflowNodeV2, { agent: string }>,
  key: string,
  site: string,
  input: JsonValue,
  options: AgentEffectOptions,
): Promise<{ output: JsonValue; agent?: AgentManifest }> {
  const target = scope.manifest.agents[node.agent];
  if (target === undefined)
    throw new FlowNodeError({
      code: "flow.unknown-agent",
      message: `Agent '${node.agent}' is not embedded in flow agent '${scope.manifest.id}'`,
      path: site,
    });
  if (isWorkflowManifestV2(target as { kind?: unknown; workflowSchemaVersion?: unknown })) {
    const flow = target as WorkflowManifestV2;
    const nested: Scope = {
      manifest: flow,
      flow: [...scope.flow, node.agent],
      pathPrefix: site,
      keyPrefix: key,
      pending: [],
      indices: scope.indices,
      iterations: scope.iterations,
      flowInput: input,
      results: {},
    };
    return { output: await runNode(ctx, nested, flow.root, ROOT_POSITION, input) };
  }
  const raw = await ctx.effect(
    "agent",
    {
      agentId: node.agent,
      input,
      path: site,
      ...(scope.flow.length > 0 ? { flow: scope.flow } : {}),
      ...(options.manifest ? { manifest: options.manifest } : {}),
    },
    { path: site, key, iterations: iterationsOf(scope.iterations) },
    options.context ?? {},
  );
  return readAgentTurn(raw);
}

async function runTool(
  ctx: FlowContext,
  scope: Scope,
  name: string,
  key: string,
  site: string,
  input: JsonValue,
): Promise<JsonValue> {
  const value = (await ctx.effect(
    "tool",
    input,
    { path: site, key, iterations: iterationsOf(scope.iterations) },
    { toolName: name },
  )) as JsonValue;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outcome = value as Readonly<Record<string, JsonValue>>;
  if (outcome.kind === "completed" && "output" in outcome) return outcome.output ?? null;
  if (outcome.kind === "denied")
    throw new FlowNodeError({
      code: "tool.denied",
      message: typeof outcome.reason === "string" ? outcome.reason : "Tool call denied",
      path: site,
    });
  return value;
}

/** Steps in order; each step's output is the next one's input. `results` is lexical. */
async function runChain(
  ctx: FlowContext,
  scope: Scope,
  steps: readonly WorkflowNodeV2[],
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  const results: Record<string, JsonValue> = {};
  const inner: Scope = { ...scope, results };
  let current = input;
  for (const [index, step] of steps.entries()) {
    current = await runNode(ctx, inner, step, childPosition(position, index), current);
    const name = step.id ?? leafPart(step);
    if (name !== undefined) results[name] = current;
  }
  return current;
}

/** `on` picks a case; the key is journaled, so replay always takes the same case. */
async function runSwitch(
  ctx: FlowContext,
  scope: Scope,
  node: Extract<WorkflowNodeV2, { switch: unknown }>["switch"],
  key: string,
  site: string,
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  const chosen = await callFn(ctx, scope, key, site, "on", stageArgs(scope, input));
  if (typeof chosen !== "string")
    throw new FlowNodeError({
      code: "fn.failed",
      message: `Switch on must return a case name, got ${typeof chosen}`,
      path: site,
    });
  const caseNode = node.cases[chosen];
  if (caseNode) return runNode(ctx, scope, caseNode, childPosition(position, chosen), input);
  if (node.default)
    return runNode(ctx, scope, node.default, childPosition(position, "default"), input);
  throw new FlowNodeError({
    code: "switch.no-match",
    message: `No Switch case is named ${JSON.stringify(chosen)} and there is no default case`,
    path: site,
  });
}

/** Run `tasks` together; fail fast on the first failure in declaration order. */
async function runTogether<T>(
  ctx: FlowContext,
  tasks: readonly (() => Promise<T>)[],
  pathOf: (index: number) => string,
): Promise<T[]> {
  const outputs: T[] = new Array(tasks.length);
  const suspensions: HostSuspension[] = [];
  const failures: { index: number; error: FlowNodeError }[] = [];
  await Promise.all(
    tasks.map(async (task, index) => {
      try {
        outputs[index] = await task();
      } catch (error) {
        if (error instanceof HostSuspension) {
          suspensions.push(error);
          return;
        }
        failures.push({
          index,
          error:
            error instanceof FlowNodeError
              ? error
              : new FlowNodeError(failureOf(error, pathOf(index))),
        });
      }
    }),
  );
  if (failures.length > 0) {
    markFailFastCancels(ctx);
    failures.sort((a, b) => a.index - b.index);
    throw failures[0]!.error;
  }
  if (suspensions.length > 0) throw suspensions[0]!;
  return outputs;
}

/** Every branch gets the same input; the output is keyed by branch, in declaration order. */
async function runParallel(
  ctx: FlowContext,
  scope: Scope,
  branches: Readonly<Record<string, WorkflowNodeV2>>,
  site: string,
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  const names = Object.keys(branches);
  const outputs = await runTogether(
    ctx,
    names.map(
      (name) => () => runNode(ctx, scope, branches[name]!, childPosition(position, name), input),
    ),
    () => site,
  );
  const result: Record<string, JsonValue> = {};
  names.forEach((name, index) => {
    result[name] = outputs[index]!;
  });
  return result;
}

/** Runs `each` once per item of its input; the output is in item order. */
async function runMap(
  ctx: FlowContext,
  scope: Scope,
  each: WorkflowNodeV2,
  site: string,
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  if (!Array.isArray(input))
    throw new FlowNodeError({
      code: "map.not-a-list",
      message: `A Map runs over its input, which must be an array; got ${input === null ? "null" : typeof input}`,
      path: site,
    });
  assertMapItemCount(input.length, ctx.limits, site);
  if (input.length === 0) return [];
  const eachPosition = childPosition(position, "each");
  return runTogether(
    ctx,
    input.map(
      (item, index) => () =>
        runNode(
          ctx,
          { ...scope, pending: [...scope.pending, index], indices: [...scope.indices, index] },
          each,
          eachPosition,
          item,
        ),
    ),
    (index) => `${site}[${index}]`,
  );
}

/** Run, verify, then stop or retry. The body keeps its session across attempts. */
async function runLoop(
  ctx: FlowContext,
  scope: Scope,
  loop: Extract<WorkflowNodeV2, { loop: unknown }>["loop"],
  key: string,
  site: string,
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  const history: LoopHistoryEntry[] = [];
  const runPosition = childPosition(position, "run");
  const runIsLeaf =
    "agent" in loop.run &&
    !isWorkflowManifestV2(
      scope.manifest.agents[loop.run.agent] as { kind?: unknown; workflowSchemaVersion?: unknown },
    );
  let current = input;
  let pinned: AgentManifest | undefined;
  let variant: AgentManifest | undefined;

  for (let iteration = 1; ; iteration += 1) {
    if (ctx.signal?.aborted)
      throw new FlowNodeError({ code: "cancelled", message: "cancelled", path: site });
    assertLoopIteration(iteration, ctx.limits, site);
    const turn: Scope = { ...scope, iterations: [...scope.iterations, iteration] };
    const loopContext = { loopPath: site, n: iteration };

    let output: JsonValue;
    if (runIsLeaf) {
      const node = loop.run as Extract<WorkflowNodeV2, { agent: string }>;
      const runKey = stageKey(node, runPosition, scope.keyPrefix);
      const runSite = siteOf(turn, node, runKey);
      let value = current;
      if (node.input)
        value = await callFn(
          ctx,
          turn,
          runKey,
          runSite,
          "input",
          stageArgs(turn, value),
          loopContext,
        );
      const result = await runAgent(ctx, turn, node, runKey, runSite, value, {
        context: loopContext,
        ...(variant ? { manifest: variant } : {}),
      });
      output = result.output;
      if (result.agent) {
        pinned ??= result.agent;
        variant = result.agent;
      }
    } else output = await runNode(ctx, turn, loop.run, runPosition, current);

    const verdict = await runVerify(ctx, turn, loop.verify, key, site, position, {
      input,
      output,
      iteration,
      loopContext,
    });

    let decision: Decision;
    if (loop.decide) {
      try {
        decision = (await callFn(
          ctx,
          turn,
          key,
          site,
          "decide",
          {
            input,
            output,
            verdict,
            iteration,
            history,
            ...(variant ? { agent: variant } : {}),
            results: turn.results,
            flowInput: turn.flowInput,
          },
          loopContext,
        )) as unknown as Decision;
      } catch (error) {
        if (error instanceof FlowNodeError && error.failure.code === "fn.failed")
          throw new FlowNodeError({
            code: "loop.stopped",
            message: error.failure.message,
            path: site,
          });
        throw error;
      }
    } else decision = verdict.pass ? { output } : { retry: verdict.feedback };

    if (!decision || typeof decision !== "object")
      throw new FlowNodeError({
        code: "loop.invalid-decision",
        message: "Loop decide must return { output } or { retry }",
        path: site,
      });
    if ("output" in decision) return decision.output;
    if (!("retry" in decision))
      throw new FlowNodeError({
        code: "loop.invalid-decision",
        message: "Loop decide must return { output } or { retry }",
        path: site,
      });
    if (loop.max !== undefined && iteration >= loop.max)
      throw new FlowNodeError({
        code: "loop.exhausted",
        message:
          `Loop stopped after ${loop.max} attempt${loop.max === 1 ? "" : "s"}` +
          (verdict.pass ? "" : `: ${verdict.feedback}`),
        path: site,
      });
    if (decision.agent !== undefined) {
      if (!runIsLeaf)
        throw new FlowNodeError({
          code: "loop.invalid-agent",
          message: "decide returned agent, but the Loop body is not an agent",
          path: site,
        });
      if (pinned && !isVariantOf(decision.agent, pinned))
        throw new FlowNodeError({
          code: "loop.invalid-agent",
          message: "decide returned a manifest that is not a variant of the body agent",
          path: site,
        });
      variant = decision.agent;
    }
    history.push({ iteration, output, verdict });
    current = decision.retry;
  }
}

async function runVerify(
  ctx: FlowContext,
  scope: Scope,
  verify: Extract<WorkflowNodeV2, { loop: unknown }>["loop"]["verify"],
  key: string,
  site: string,
  position: string,
  args: {
    readonly input: JsonValue;
    readonly output: JsonValue;
    readonly iteration: number;
    readonly loopContext: Record<string, unknown>;
  },
): Promise<Verdict> {
  try {
    if ("fn" in verify)
      return (await callFn(
        ctx,
        scope,
        key,
        site,
        "verify",
        {
          input: args.input,
          output: args.output,
          iteration: args.iteration,
          results: scope.results,
          flowInput: scope.flowInput,
        },
        args.loopContext,
      )) as unknown as Verdict;
    // A verifier agent judges `{ task, response, iteration }` in a fresh session per attempt.
    const judged = { task: args.input, response: args.output, iteration: args.iteration };
    return (await runNode(ctx, scope, verify, childPosition(position, "verify"), judged, {
      context: { ...args.loopContext, role: "verify-agent" },
    })) as unknown as Verdict;
  } catch (error) {
    if (error instanceof HostSuspension) throw error;
    const failure = failureOf(error, site);
    if (failure.code === "loop.verify-failed") throw error;
    throw new FlowNodeError({ code: "loop.verify-failed", message: failure.message, path: site });
  }
}
