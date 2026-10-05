import { projectAsset } from "@nylorun/runtime/node";
import type { CapabilityDeclaration } from "@nylorun/agents/define";
import { loadToolsFromDirectory } from "./load.js";
import { serviced, TOOLS_URL } from "./service.js";
import { EXAMPLES_ROOT } from "../root.js";

export const TOOLS_CATALOG = projectAsset(
  "agents/shared/tools/catalog",
  EXAMPLES_ROOT,
);

export type ToolsSource = { readonly directory: string; readonly url?: string };

/** The catalog's code tools, as the tools service (`src/tools/server.ts`) runs them. */
export function catalog(source: ToolsSource = { directory: TOOLS_CATALOG }) {
  return loadToolsFromDirectory(source.directory);
}

/**
 * The catalog as `http()` tools: the Runtime calls the tools service for each one, at
 * `source.url` (default TOOLS_URL).
 */
export async function tools(
  source: ToolsSource = { directory: TOOLS_CATALOG },
): Promise<CapabilityDeclaration> {
  const loaded = await catalog(source);
  if (loaded.length === 0) return { id: "tools" };
  return { id: "tools", tools: loaded.map((tool) => serviced(tool, source.url ?? TOOLS_URL)) };
}
