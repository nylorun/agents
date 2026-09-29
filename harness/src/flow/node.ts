import type { JsonValue } from "@nylorun/core/define";
import { HarnessError } from "@nylorun/core/define";
import type { WorkflowNode } from "@nylorun/core";
import type { FlowContext } from "./context.js";
import { joinPath, mapItemPath, nodeKeyOf } from "./paths.js";
import { runChain } from "./chain.js";
import { runSwitch } from "./switch.js";
import { runParallel } from "./parallel.js";
import { runMap } from "./map.js";
import { runLoopNode } from "./loop.js";
import { FlowNodeError } from "./types.js";

/** Path part / id for a node among its siblings. */
export function nodePart(node: WorkflowNode): string {
  if ("agent" in node) return node.agent;
  if ("tool" in node) return node.tool.name;
  if ("chain" in node) return node.chain.id;
  if ("switch" in node) return node.switch.id;
  if ("parallel" in node) return node.parallel.id;
  if ("map" in node) return node.map.id;
  if ("loop" in node) return node.loop.id;
  if ("slot" in node) return node.slot.id ?? nodePart(node.slot.run);
  throw new HarnessError("execution.invalid-state", "Unknown workflow node kind");
}

export type SlotUnwrap = {
  readonly run: WorkflowNode;
  readonly inputFn: boolean;
  readonly part: string;
};

export function unwrapSlot(node: WorkflowNode): SlotUnwrap {
  if ("slot" in node) {
    return {
      run: node.slot.run,
      inputFn: !!node.slot.input,
      part: node.slot.id ?? nodePart(node.slot.run),
    };
  }
  return { run: node, inputFn: false, part: nodePart(node) };
}

export type RunNodeOptions = {
  /**
   * Input of the primitive that owns the slot (`workflows.md` §4).
   * Defaults to `input` (the value the child would receive without a reshape).
   */
  readonly ownerInput?: JsonValue;
  /** Map item: slot `input` receives `{ value: item, input: mapInput, results, index }`. */
  readonly map?: { readonly item: JsonValue; readonly mapInput: JsonValue; readonly index: number };
};

/**
 * Run any workflow node at `path` with `input`.
 * Slots: optional `fn` reshape, then the wrapped runnable.
 */
export async function runNode(
  ctx: FlowContext,
  node: WorkflowNode,
  path: string,
  input: JsonValue,
  options: RunNodeOptions = {},
): Promise<JsonValue> {
  if ("slot" in node) {
    let childInput = input;
    if (node.slot.input) {
      const results = ctx.nearestResults();
      const fnArgs = options.map
        ? {
            value: options.map.item,
            input: options.map.mapInput,
            results,
            index: options.map.index,
          }
        : {
            value: input,
            input: options.ownerInput ?? input,
            results,
          };
      childInput = (await ctx.effect(
        "fn",
        fnArgs,
        { path, key: `${nodeKeyOf(path)}/input`, role: "slot-input" },
        { role: "slot-input" },
      )) as JsonValue;
    }
    return runRunnable(ctx, node.slot.run, path, childInput);
  }
  return runRunnable(ctx, node, path, input);
}

async function runRunnable(
  ctx: FlowContext,
  node: WorkflowNode,
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  if ("slot" in node) return runNode(ctx, node, path, input);
  if ("agent" in node) return runAgent(ctx, node.agent, path, input);
  if ("tool" in node) return runTool(ctx, node.tool.name, path, input);
  if ("chain" in node) return runChain(ctx, node.chain, path, input);
  if ("switch" in node) return runSwitch(ctx, node.switch, path, input);
  if ("parallel" in node) return runParallel(ctx, node.parallel, path, input);
  if ("map" in node) return runMap(ctx, node.map, path, input);
  if ("loop" in node) return runLoopNode(ctx, node.loop, path, input);
  throw new HarnessError("execution.invalid-state", "Unknown workflow node kind");
}

async function runAgent(
  ctx: FlowContext,
  agentId: string,
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  return (await ctx.effect(
    "agent",
    { agentId, input, path },
    { path, key: nodeKeyOf(path) },
  )) as JsonValue;
}

async function runTool(
  ctx: FlowContext,
  name: string,
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  const value = await ctx.effect("tool", input, { path, key: nodeKeyOf(path) }, { toolName: name });
  return toolNodeOutput(value as JsonValue, path);
}

/**
 * The executor settles a tool node like any tool: `{ kind: "completed", output }` or
 * `{ kind: "denied", reason }`. The flow passes on the output only. Failed values are
 * already raised by `ctx.effect`.
 */
function toolNodeOutput(value: JsonValue, path: string): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outcome = value as Readonly<Record<string, JsonValue>>;
  if (outcome.kind === "completed" && "output" in outcome) return outcome.output ?? null;
  if (outcome.kind === "denied")
    throw new FlowNodeError({
      code: "tool.denied",
      message: typeof outcome.reason === "string" ? outcome.reason : "Tool call denied",
      path,
    });
  return value;
}

export { joinPath, mapItemPath, nodeKeyOf };
