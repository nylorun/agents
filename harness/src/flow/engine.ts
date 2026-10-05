/**
 * Flow engine for workflow manifest v3 (`flow-3`). A flow is data: every value a stage sees
 * comes from the flow's input and the outputs of the agents and tools before it. Returns
 * effects only (SD-I1).
 *
 * - The first stage gets the flow's input; every later stage gets the previous output.
 * - A Switch reads the previous output: a string is the case name, and so is an object's
 *   `route` field. The chosen case gets the whole output.
 * - A Map runs over the previous output when it is an array, or over its `items` array.
 * - A Parallel gives every branch the same input; its output is keyed by branch.
 * - A Loop runs its body, asks its verifier agent for a verdict, and stops on a pass or
 *   retries with the feedback, up to `max` attempts. The body keeps its session.
 * - Agent and tool sessions are named by leaf paths: the leaf's id, `[i]` per Map item,
 *   under nested flow agents' ids. Control stages add nothing.
 * - Leaf agents come from the manifest's embedded `agents`; nested flow agents run inline
 *   with their own input. An agent effect carries its flow agent's input as `flowInput`
 *   when the stage's own input differs, so the host can show the agent the original request.
 */
import {
  HarnessError,
  ROOT_POSITION,
  canonical,
  childPosition,
  hashManifest,
  indexSuffix,
  isVerdict,
  isWorkflowManifest,
  leafPart,
  leafPath,
  stageKey,
  type JsonValue,
  type Verdict,
  type WorkflowManifest,
  type WorkflowNode,
} from "@nylorun/core/define";
import { WorkflowManifestSchema } from "@nylorun/core/contracts";
import type { DurableHost } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import { CHECKPOINT_VERSION, FLOW_ENGINE_VERSION } from "../compatibility.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import {
  createFlowContext,
  failureOf,
  markFailFastCancels,
  settleInFlight,
  suspendedResult,
  type FlowContext,
} from "./context.js";
import { assertLoopIteration, assertMapItemCount, type FlowOperatorLimits } from "./limits.js";
import { iterationsOf } from "./paths.js";
import { runToolEffect } from "./tool.js";
import { FlowNodeError, type FlowDurableResult } from "./types.js";

/** Where a node runs: its flow, path prefixes, Map indices and Loop iterations. */
type Scope = {
  /** The flow agent whose `agents` resolve agent nodes here. */
  readonly manifest: WorkflowManifest;
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
  /** The input of the flow agent this scope runs in. */
  readonly flowInput: JsonValue;
};

/** Extra context an agent effect carries for the host (Loop number, verifier role). */
type AgentContext = Record<string, unknown>;

export async function runFlowDurable(options: {
  manifest: WorkflowManifest;
  checkpoint: FlowCheckpoint;
  host: DurableHost;
  signal?: AbortSignal;
  /** Operator ceilings (`maxMapItems`, `maxLoopIterations`). Host/Runtime supplies these. */
  limits?: Partial<FlowOperatorLimits> | null;
}): Promise<FlowDurableResult> {
  const { manifest, checkpoint, signal } = options;
  WorkflowManifestSchema.parse(manifest);
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    checkpoint.engineVersion !== FLOW_ENGINE_VERSION ||
    checkpoint.manifestHash !== hashManifest(manifest)
  )
    throw new HarnessError("execution.incompatible", "Incompatible flow checkpoint");

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
  };
  try {
    if (signal?.aborted)
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const output = await runNode(ctx, scope, manifest.root, ROOT_POSITION, checkpoint.input);
    return { status: "completed", checkpoint, result: { status: "completed", output } };
  } catch (error) {
    await settleInFlight(ctx);
    if (error instanceof HostSuspension) return suspendedResult(ctx);
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
function siteOf(scope: Scope, node: WorkflowNode, key: string): string {
  const part = leafPart(node);
  return part === undefined
    ? `${key}${indexSuffix(scope.indices)}`
    : leafPath(scope.pathPrefix, part, scope.pending);
}

async function runNode(
  ctx: FlowContext,
  scope: Scope,
  node: WorkflowNode,
  position: string,
  input: JsonValue,
  context: AgentContext = {},
): Promise<JsonValue> {
  const key = stageKey(node, position, scope.keyPrefix);
  const site = siteOf(scope, node, key);
  if ("agent" in node) return runAgent(ctx, scope, node, key, site, input, context);
  if ("tool" in node) return runTool(ctx, scope, node.tool.name, key, site, input);
  if ("chain" in node) return runChain(ctx, scope, node.chain, position, input);
  if ("switch" in node) return runSwitch(ctx, scope, node.switch, site, position, input);
  if ("parallel" in node) return runParallel(ctx, scope, node.parallel, site, position, input);
  if ("map" in node) return runMap(ctx, scope, node.map.each, site, position, input);
  if ("loop" in node) return runLoop(ctx, scope, node.loop, site, position, input);
  throw new HarnessError("execution.invalid-state", "Unknown workflow node kind");
}

/**
 * An agent node: a leaf agent runs as one turn in its own session; a nested flow agent
 * runs inline, under its own id, with its own input.
 */
async function runAgent(
  ctx: FlowContext,
  scope: Scope,
  node: Extract<WorkflowNode, { agent: string }>,
  key: string,
  site: string,
  input: JsonValue,
  context: AgentContext,
): Promise<JsonValue> {
  const target = scope.manifest.agents[node.agent];
  if (target === undefined)
    throw new FlowNodeError({
      code: "flow.unknown-agent",
      message: `Agent '${node.agent}' is not embedded in flow agent '${scope.manifest.id}'`,
      path: site,
    });
  if (isWorkflowManifest(target as WorkflowManifest)) {
    const flow = target as WorkflowManifest;
    const nested: Scope = {
      manifest: flow,
      flow: [...scope.flow, node.agent],
      pathPrefix: site,
      keyPrefix: key,
      pending: [],
      indices: scope.indices,
      iterations: scope.iterations,
      flowInput: input,
    };
    return runNode(ctx, nested, flow.root, ROOT_POSITION, input);
  }
  return (await ctx.effect(
    "agent",
    {
      agentId: node.agent,
      input,
      path: site,
      ...(scope.flow.length > 0 ? { flow: scope.flow } : {}),
      ...(canonical(input) === canonical(scope.flowInput) ? {} : { flowInput: scope.flowInput }),
    },
    { path: site, key, iterations: iterationsOf(scope.iterations) },
    context,
  )) as JsonValue;
}

async function runTool(
  ctx: FlowContext,
  scope: Scope,
  name: string,
  key: string,
  site: string,
  input: JsonValue,
): Promise<JsonValue> {
  const value = await runToolEffect(ctx, name, input, {
    path: site,
    key,
    iterations: iterationsOf(scope.iterations),
  });
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

/** Steps in order; each step's output is the next one's input. */
async function runChain(
  ctx: FlowContext,
  scope: Scope,
  steps: readonly WorkflowNode[],
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  let current = input;
  for (const [index, step] of steps.entries())
    current = await runNode(ctx, scope, step, childPosition(position, index), current);
  return current;
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A short description of a value for a failure message. */
function describe(value: JsonValue): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The case the previous output names: itself when a string, else its `route` field. */
async function runSwitch(
  ctx: FlowContext,
  scope: Scope,
  node: Extract<WorkflowNode, { switch: unknown }>["switch"],
  site: string,
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  const name =
    typeof input === "string"
      ? input
      : isRecord(input) && typeof input.route === "string"
        ? input.route
        : undefined;
  const chosen = name === undefined ? undefined : node.cases[name];
  if (chosen) return runNode(ctx, scope, chosen, childPosition(position, name!), input);
  if (node.default)
    return runNode(ctx, scope, node.default, childPosition(position, "default"), input);
  throw new FlowNodeError({
    code: "switch.no-match",
    message:
      name === undefined
        ? `Switch read ${describe(input)}, which names no case: the previous output must be a case name or an object with a string route field, and there is no default case`
        : `Switch read the case name ${JSON.stringify(name)}, but no case has that name (cases: ${Object.keys(node.cases).join(", ")}) and there is no default case`,
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
  branches: Readonly<Record<string, WorkflowNode>>,
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

/** Runs `each` once per item of the previous output, or of its `items`; output in item order. */
async function runMap(
  ctx: FlowContext,
  scope: Scope,
  each: WorkflowNode,
  site: string,
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  const items = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.items)
      ? input.items
      : undefined;
  if (!items)
    throw new FlowNodeError({
      code: "map.not-a-list",
      message: `A Map runs over an array or { items: [...] }; got ${describe(input)}`,
      path: site,
    });
  assertMapItemCount(items.length, ctx.limits, site);
  if (items.length === 0) return [];
  const eachPosition = childPosition(position, "each");
  return runTogether(
    ctx,
    items.map(
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

/**
 * Run the body, ask the verifier agent, then stop on a pass or retry with the feedback. The
 * body keeps its session across attempts; the verifier gets a fresh one per attempt.
 */
async function runLoop(
  ctx: FlowContext,
  scope: Scope,
  loop: Extract<WorkflowNode, { loop: unknown }>["loop"],
  site: string,
  position: string,
  input: JsonValue,
): Promise<JsonValue> {
  const runPosition = childPosition(position, "run");
  let current = input;
  for (let iteration = 1; ; iteration += 1) {
    if (ctx.signal?.aborted)
      throw new FlowNodeError({ code: "cancelled", message: "cancelled", path: site });
    assertLoopIteration(iteration, ctx.limits, site);
    const turn: Scope = { ...scope, iterations: [...scope.iterations, iteration] };
    const loopContext = { loopPath: site, n: iteration };
    const output = await runNode(ctx, turn, loop.run, runPosition, current, loopContext);
    const verdict = await runVerify(ctx, turn, loop.verify, site, position, {
      task: input,
      response: output,
      iteration,
      context: loopContext,
    });
    if (verdict.pass) return output;
    if (iteration >= loop.max)
      throw new FlowNodeError({
        code: "loop.exhausted",
        message: `Loop stopped after ${loop.max} attempt${loop.max === 1 ? "" : "s"}: ${verdict.feedback}`,
        path: site,
      });
    current = verdict.feedback;
  }
}

/** A verifier agent judges `{ task, response, iteration }`; its output must be a verdict. */
async function runVerify(
  ctx: FlowContext,
  scope: Scope,
  verify: Extract<WorkflowNode, { loop: unknown }>["loop"]["verify"],
  site: string,
  position: string,
  args: {
    readonly task: JsonValue;
    readonly response: JsonValue;
    readonly iteration: number;
    readonly context: AgentContext;
  },
): Promise<Verdict> {
  let value: JsonValue;
  try {
    value = await runNode(
      ctx,
      scope,
      verify,
      childPosition(position, "verify"),
      { task: args.task, response: args.response, iteration: args.iteration },
      { ...args.context, role: "verify-agent" },
    );
  } catch (error) {
    if (error instanceof HostSuspension) throw error;
    const failure = failureOf(error, site);
    if (failure.code === "loop.verify-failed") throw error;
    throw new FlowNodeError({ code: "loop.verify-failed", message: failure.message, path: site });
  }
  if (!isVerdict(value))
    throw new FlowNodeError({
      code: "loop.verify-failed",
      message: `The verifier must return { pass: boolean, feedback?: string }, with feedback when pass is false; got ${describe(value)}`,
      path: site,
    });
  return value;
}
