import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";

/** Resolve authored catalogs and subprocess assets under an explicit project root. */
export function projectAsset(path: string, root?: string): string {
  if (!root) {
    throw new Error("projectAsset requires an explicit project root");
  }
  const source = resolve(root, path);
  if (relative(root, source).startsWith(".."))
    throw new Error("Asset must be inside the project.");
  return existsSync(source) ? source : resolve(root, "dist", path);
}
