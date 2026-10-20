/**
 * `nylorun apply --agent [<id>]` (track T7): after a manifest is saved, or found unchanged, make the
 * Agent that runs it, or move it to the latest version, as `nylorun agents put <id> --manifest
 * <name>` does. The id defaults to the manifest's name. What happened is printed, with what the
 * Agent needs a person for (an unset required secret).
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { RuntimeError, type AgentView, type AgentsClient } from "@nylorun/agents";
import type { StackDeps } from "../stack/commands.js";
import { manifestOf, pendingOf } from "./agents.js";
import { runtimeCall, usageError } from "./runtime.js";

/**
 * `--agent [<id>]`, or `--agent=<id>`, taken out of `args`. The word after `--agent` is its id
 * unless it is a flag or names a directory under `cwd` (a folder to apply).
 */
export function takeAgentFlag(args: readonly string[], cwd: string): { args: string[]; agent?: { id?: string } } {
  const rest: string[] = [];
  let agent: { id?: string } | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--agent=")) {
      const id = arg.slice("--agent=".length);
      if (id === "") throw usageError("--agent= needs an Agent id.");
      agent = { id };
      continue;
    }
    if (arg !== "--agent") {
      rest.push(arg);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-") && !isDirectory(resolve(cwd, next))) {
      agent = { id: next };
      index += 1;
    } else agent = {};
  }
  return { args: rest, ...(agent ? { agent } : {}) };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Makes Agent `id` from manifest `name`, or moves it to the manifest's latest version, and says which. */
export async function putAgent(deps: StackDeps, client: AgentsClient, label: string, id: string, name: string): Promise<AgentView> {
  let before: AgentView | undefined;
  try {
    before = await client.agents.get(id);
  } catch (error) {
    if (!(error instanceof RuntimeError && error.status === 404)) await runtimeCall(() => Promise.reject(error));
  }
  const agent = await runtimeCall(() => client.agents.put(id, { manifest: name }));
  const what = !before
    ? `Made Agent ${agent.id}`
    : before.resolvedVersion !== agent.resolvedVersion || before.manifest !== agent.manifest || before.targetVersion !== agent.targetVersion
      ? `Moved Agent ${agent.id} from ${manifestOf(before)}`
      : `Agent ${agent.id} is unchanged`;
  deps.err(`${what}: it runs ${manifestOf(agent)} on ${label}${pendingOf(agent)}.`);
  for (const item of agent.attention ?? []) if (!item.sessionId) deps.err(`  attention: ${item.reason}`);
  return agent;
}
