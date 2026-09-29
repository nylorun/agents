import type { JsonValue } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import {
  assertValidPathPart,
  diagnostic,
  fail,
} from "./diagnostics.js";
import { emptyAccumulator, finishWorkflow, mergeChild } from "./build.js";
import { remapNodeKeys, resolveChild, runnableId } from "./runnable.js";
import type { ChildRef } from "./slot.js";
import type { BuiltWorkflow, OutputOf } from "./types.js";

export type MapOver<In, Item> = (input: In) => readonly Item[];

export interface MapOptions<
  Each extends ChildRef = ChildRef,
  In = JsonValue,
  Item = JsonValue,
> {
  readonly id: string;
  readonly over: MapOver<In, Item>;
  readonly each: Each;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
}

/**
 * Run `each` once per item from pure `over(input)` (map.md).
 * Output is an array of each item's output, in item order. Empty list → [].
 */
export function Map<
  Each extends ChildRef,
  In = JsonValue,
  Item = JsonValue,
>(options: MapOptions<Each, In, Item>): BuiltWorkflow<In, OutputOf<Each>[]> {
  const { id, over, each } = options;
  if (!id) fail([diagnostic("map.missing-id", "Map requires id")]);
  assertValidPathPart(id, "Map id");
  if (typeof over !== "function")
    fail([diagnostic("map.missing-over", "Map requires over")]);
  if (each === undefined || each === null)
    fail([diagnostic("map.missing-each", "Map requires each")]);

  const resolved = resolveChild(each);
  assertValidPathPart(resolved.id, "Map each id");

  const acc = emptyAccumulator();
  // Node key drops Map indices: implement/code, not implement[i]/code.
  const eachPath = `${id}/${resolved.id}`;
  mergeChild(acc, {
    agents: resolved.agents,
    nodes: remapNodeKeys(resolved.nodes, resolved.id, eachPath),
  });
  acc.nodes[`${id}/over`] = {
    kind: "fn",
    fn: over as (...args: never[]) => unknown,
  };

  // Preserve each child's id for path construction (map.md §3.2).
  void runnableId(each);

  return finishWorkflow<In, OutputOf<Each>[]>({
    id,
    root: {
      map: {
        id,
        over: { fn: true },
        each: resolved.node,
      },
    },
    acc,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
  });
}
