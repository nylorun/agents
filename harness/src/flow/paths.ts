/** Path, node key and iteration-vector helpers (workflows.md §6). */

export function joinPath(parent: string, part: string): string {
  return parent ? `${parent}/${part}` : part;
}

/**
 * Map item path: `<map path>[index]/<each id>` (workflows.md §6).
 * Example: `implement[2]/code`.
 */
export function mapItemPath(mapPath: string, index: number, eachId: string): string {
  return `${mapPath}[${index}]/${eachId}`;
}

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
 * `role` separates two effects of one kind on one path, e.g. a slot `input`
 * and the Map `over` or Switch `on` it wraps.
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
