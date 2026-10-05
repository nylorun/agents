import type { BoundToolDefinition } from "./bound.js";
import type { ToolDefinition } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import { normalizeToolDefinition, normalizedSchemasFor } from "./schema.js";
import { delegateOf } from "./delegate.js";

/** Prepares an executable Tool and records its middleware slot provenance. */
export function bindTool(
  item: ToolDefinition,
  owner: BoundToolDefinition["owner"]
): BoundToolDefinition {
  const prepared = normalizeToolDefinition(item);
  if (!prepared.name)
    throw new HarnessError("tool.invalid-name", "Tool name must not be empty");
  if (typeof prepared.execute !== "function")
    throw new HarnessError(
      "tool.invalid",
      `Tool '${prepared.name}' must provide execute()`
    );
  const schemas = normalizedSchemasFor(prepared);
  const delegate = delegateOf(item);
  return Object.freeze({
    // Keep the original object identity so ToolRegistry WeakMap lookups succeed.
    source: item,
    name: prepared.name,
    ...(prepared.description ? { description: prepared.description } : {}),
    inputSchema: schemas.inputSchema,
    ...(schemas.outputSchema === undefined
      ? {}
      : { outputSchema: schemas.outputSchema }),
    execute: prepared.execute!.bind(prepared) as BoundToolDefinition["execute"],
    ...(prepared.approval === undefined ? {} : { approval: prepared.approval }),
    ...(prepared.effects === undefined ? {} : { effects: prepared.effects }),
    owner: Object.freeze({ ...owner }),
    ...(delegate === undefined ? {} : { delegate }),
  });
}
