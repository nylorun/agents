/** Path, node key and iteration-vector helpers (workflows.md §6). */

/** Drop Map indices from a path to get the node key. */
export function nodeKeyOf(path: string): string {
  return path.replace(/\[\d+]/g, "");
}

/** Iteration vector string: enclosing Loop numbers outermost first, or "-" outside Loops. */
export function iterationsOf(vector: readonly number[]): string {
  return vector.length === 0 ? "-" : vector.join(".");
}

/**
 * Effect id for a flow effect (workflows.md §10).
 * `role` separates two effects of one kind on one path, e.g. a tool node's runs after it asked.
 */
export function flowEffectId(input: {
  readonly turnId: string;
  readonly segment: number;
  readonly path: string;
  readonly kind: string;
  readonly iterations: string;
  readonly role?: string;
}): string {
  const kind = input.role === undefined ? input.kind : `${input.kind}.${input.role}`;
  return `${input.turnId}:${input.segment}:flow:${input.path}:${kind}:${input.iterations}`;
}
