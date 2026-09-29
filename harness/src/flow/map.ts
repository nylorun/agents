import type { JsonValue } from "@nylorun/core/define";
import type { WorkflowMapNode } from "@nylorun/core";
import { HostSuspension } from "../loop/host-suspension.js";
import type { FlowContext } from "./context.js";
import { failureOf, markFailFastCancels } from "./context.js";
import { assertMapItemCount } from "./limits.js";
import { FlowNodeError } from "./types.js";
import { mapItemPath, nodeKeyOf } from "./paths.js";
import { runNode, unwrapSlot } from "./node.js";

/**
 * Map: journal `over`, run each item concurrently at `<map>[i]/<each id>`; fail-fast.
 */
export async function runMap(
  ctx: FlowContext,
  node: WorkflowMapNode["map"],
  path: string,
  input: JsonValue,
): Promise<JsonValue> {
  const over = await ctx.effect(
    "fn",
    input,
    { path, key: `${nodeKeyOf(path)}/over` },
    { role: "map-over" },
  );

  if (!Array.isArray(over)) {
    throw new FlowNodeError({
      code: "map.not-a-list",
      message: "Map.over did not return an array",
      path,
    });
  }

  const items = over as JsonValue[];
  // Operator ceiling before any item starts (WF-L2 / MAP-E2).
  assertMapItemCount(items.length, ctx.limits, path);
  // Runtime emits map.items { path, count } after over is journaled.
  if (items.length === 0) return [];

  const { part: eachPart } = unwrapSlot(node.each);
  const outputs: JsonValue[] = new Array(items.length);
  const suspensions: HostSuspension[] = [];
  const failures: FlowNodeError[] = [];

  await Promise.all(
    items.map(async (item, index) => {
      const itemPath = mapItemPath(path, index, eachPart);
      try {
        const eachNode = node.each;
        if ("slot" in eachNode && eachNode.slot.input) {
          outputs[index] = await runNode(ctx, eachNode, itemPath, item, {
            map: { item, mapInput: input, index },
          });
        } else {
          outputs[index] = await runNode(ctx, eachNode, itemPath, item);
        }
      } catch (error) {
        if (error instanceof HostSuspension) {
          suspensions.push(error);
          return;
        }
        failures.push(
          error instanceof FlowNodeError ? error : new FlowNodeError(failureOf(error, itemPath)),
        );
      }
    }),
  );

  if (failures.length > 0) {
    markFailFastCancels(ctx);
    failures.sort((a, b) => indexFromPath(a.failure.path) - indexFromPath(b.failure.path));
    throw failures[0]!;
  }

  if (suspensions.length > 0) throw suspensions[0]!;

  return outputs;
}

function indexFromPath(path: string | undefined): number {
  if (!path) return Number.MAX_SAFE_INTEGER;
  const match = path.match(/\[(\d+)\]/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
