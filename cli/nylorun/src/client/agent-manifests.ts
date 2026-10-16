/**
 * `nylorun agent-manifests`: the Tenant's agent manifests (protocol 16, track T2), named and
 * versioned documents with a harness and a runtime section, through the Runtime API. They are
 * saved with `nylorun apply` (`apply.ts`), which composes them from a folder's files; these
 * commands read and delete them.
 */
import type { AgentManifestView } from "@nylorun/agents";
import { parseAgentManifestRef } from "@nylorun/core/contracts";
import type { StackDeps } from "../stack/commands.js";
import {
  parseFlags,
  positional,
  printJson,
  printTable,
  runtimeCall,
  runtimeClient,
  runtimeFlagsUsage,
  usageError,
} from "./runtime.js";

export const agentManifestsUsage = `nylorun agent-manifests <command>

The Tenant's agent manifests, through the Runtime API with an application key (or
NYLORUN_TOKEN). Save one with nylorun apply <dir>.

  list [--json]                       each manifest's latest version: its runtime kind, harness
                                      and the Agents made from it
  get <name>[@<n>]                    a manifest's latest version (or version n), as JSON
  versions <name>                     its versions, with the Agents made from each
  rm <name>                           delete every version (refused while an Agent was made
                                      from one)

${runtimeFlagsUsage}`;

/** The harness that runs a manifest's loop, as the list prints it. */
function harnessOf(view: AgentManifestView): string {
  const { harness } = view.manifest;
  const id = harness.id ?? "nylorun";
  return "kind" in harness && harness.kind === "workflow" ? `${id} (flow)` : id;
}

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agent-manifests list [--json]";
  const flags = parseFlags(args, { booleans: ["--json"] }, usage);
  positional(flags, 0, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const manifests = await runtimeCall(() => client.agentManifests.list());
  if (flags.booleans.has("--json")) {
    printJson(deps, manifests);
    return 0;
  }
  if (manifests.length === 0) deps.out(`No agent manifests on ${connection.label}. Save one with nylorun apply <dir>.`);
  else
    printTable(deps, [
      ["NAME", "VERSION", "KIND", "HARNESS", "AGENTS"],
      ...manifests.map((view) => [
        view.name,
        String(view.version),
        view.manifest.runtime?.kind ?? "none",
        harnessOf(view),
        String(view.agents),
      ]),
    ]);
  return 0;
}

async function get(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agent-manifests get <name>[@<n>]";
  const flags = parseFlags(args, {}, usage);
  const [ref] = positional(flags, 1, usage);
  const parsed = parseAgentManifestRef(ref!);
  if (!parsed) throw usageError(`${ref} is not an agent manifest's name, or name@version such as triage@3.`);
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.agentManifests.get(parsed.name, parsed.version)));
  return 0;
}

async function versions(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agent-manifests versions <name>";
  const flags = parseFlags(args, {}, usage);
  const [name] = positional(flags, 1, usage);
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.agentManifests.versions(name!)));
  return 0;
}

async function remove(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agent-manifests rm <name>";
  const flags = parseFlags(args, {}, usage);
  const [name] = positional(flags, 1, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const deleted = await runtimeCall(() => client.agentManifests.delete(name!));
  if (!deleted.deleted) {
    deps.err(`No agent manifest ${name} on ${connection.label}.`);
    return 1;
  }
  deps.out(`Deleted agent manifest ${name}: every version.`);
  return 0;
}

const COMMANDS: Record<string, (deps: StackDeps, args: readonly string[]) => Promise<number>> = {
  list,
  ls: list,
  get,
  versions,
  rm: remove,
  delete: remove,
};

/** `nylorun agent-manifests <command> ...` */
export async function agentManifestsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    deps.out(agentManifestsUsage);
    return 0;
  }
  if (sub === "save")
    throw usageError("Save an agent manifest with nylorun apply <dir>: it composes agent.manifest.json and the files it names.");
  const command = sub !== undefined && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!command)
    throw usageError(sub ? `Unknown agent-manifests command ${sub}.\n${agentManifestsUsage}` : agentManifestsUsage);
  return command(deps, rest);
}
