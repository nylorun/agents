/**
 * `nylorun agents`: the Tenant's saved agents (`/v1/agents`, Runtime API). `save` takes a manifest
 * and the folders that hold its files: a manifest names each definition file by the SHA-256 of
 * its bytes (a skill's `files`), so the files are matched by content, whatever their paths.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { definitionFileHash } from "@nylorun/agents";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import {
  parseFlags,
  positional,
  printJson,
  printTable,
  readJson,
  runtimeCall,
  runtimeClient,
  runtimeFlagsUsage,
  usageError,
} from "./runtime.js";

export const agentsUsage = `nylorun agents <list|get|save>

The Tenant's saved agents, through the Runtime API with an application key (or NYLORUN_TOKEN).

  list [--json]                       id, kind and description of each agent
  get <id>                            the agent's manifest, as JSON
  save <manifest.json|-> [--files <dir>]... [--implementation-version <v>]
                                      save the agent the manifest describes, first uploading the
                                      definition files it names from the folders given (found by
                                      their SHA-256, whatever their paths)

${runtimeFlagsUsage}`;

const HASH = /^sha256:[0-9a-f]{64}$/;

/** Every `sha256:<hex>` a manifest names under a `files` map, with where it names it. */
export function namedFiles(manifest: unknown): Map<string, string> {
  const named = new Map<string, string>();
  const walk = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    for (const [key, child] of Object.entries(value)) {
      if (key === "files" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [file, hash] of Object.entries(child))
          if (typeof hash === "string" && HASH.test(hash) && !named.has(hash))
            named.set(hash, `${path}.files["${file}"]`);
      } else walk(child, `${path}.${key}`);
    }
  };
  walk(manifest, "manifest");
  return named;
}

/** The files under `dirs`, by their hash. */
async function filesByHash(dirs: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        found.set(await definitionFileHash(new Uint8Array(await readFile(path))), path);
    }
  };
  for (const dir of dirs) {
    try {
      await visit(dir);
    } catch (error) {
      throw new CliError(`Cannot read --files ${dir}: ${(error as Error).message}`, 1);
    }
  }
  return found;
}

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents list [--json]";
  const flags = parseFlags(args, { booleans: ["--json"] }, usage);
  positional(flags, 0, usage);
  const { client } = await runtimeClient(deps, flags);
  const { agents } = await runtimeCall(() => client.listAgents());
  if (flags.booleans.has("--json")) {
    printJson(deps, agents);
    return 0;
  }
  if (agents.length === 0) {
    deps.out("No agents saved.");
    return 0;
  }
  printTable(deps, [
    ["ID", "KIND", "DESCRIPTION"],
    ...agents.map((agent) => {
      const manifest = "manifest" in agent ? (agent.manifest as { kind?: string; description?: string }) : undefined;
      const description = ("description" in agent ? agent.description : undefined) ?? manifest?.description;
      return [agent.agentId, manifest?.kind ?? "agent", description ?? "-"];
    }),
  ]);
  return 0;
}

async function get(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents get <id>";
  const flags = parseFlags(args, {}, usage);
  const [id] = positional(flags, 1, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const { agents } = await runtimeCall(() => client.listAgents());
  const agent = agents.find((item) => item.agentId === id);
  if (!agent) {
    deps.err(`No agent ${id} on ${connection.label}.`);
    return 1;
  }
  printJson(deps, agent);
  return 0;
}

async function save(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun agents save <manifest.json|-> [--files <dir>]... [--implementation-version <v>]";
  const flags = parseFlags(args, { values: ["--implementation-version"], lists: ["--files"] }, usage);
  const [path] = positional(flags, 1, usage);
  const manifest = await readJson(path!, "The manifest");
  if (typeof manifest.id !== "string" || manifest.id === "")
    throw usageError("The manifest has no id.");
  const named = namedFiles(manifest);
  const found =
    named.size === 0 ? new Map<string, string>() : await filesByHash(flags.lists.get("--files") ?? []);
  const missing = [...named].filter(([hash]) => !found.has(hash));
  if (missing.length > 0)
    throw new CliError(
      `The manifest names ${missing.length} ${missing.length === 1 ? "file" : "files"} not found under ${
        flags.lists.get("--files")?.join(", ") || "any --files folder"
      }:\n${missing.map(([hash, where]) => `  ${where} = ${hash}`).join("\n")}`,
      1,
    );
  const { client, connection } = await runtimeClient(deps, flags);
  let uploaded = 0;
  for (const hash of named.keys()) {
    if (await runtimeCall(() => client.files.has(hash))) continue;
    const bytes = new Uint8Array(await readFile(found.get(hash)!));
    await runtimeCall(() => client.files.upload(bytes, { sha256: hash }));
    uploaded += 1;
  }
  const version = flags.values.get("--implementation-version");
  const saved = await runtimeCall(() =>
    client.saveAgent(
      { id: manifest.id as string, manifest: manifest as never },
      version === undefined ? {} : { implementationVersion: version },
    ),
  );
  deps.err(
    `Saved agent ${manifest.id} on ${connection.label}${
      named.size ? ` (${named.size} files, ${uploaded} uploaded)` : ""
    }.`,
  );
  printJson(deps, saved);
  return 0;
}

/** `nylorun agents <list|get|save> ...` */
export async function agentsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    deps.out(agentsUsage);
    return 0;
  }
  if (sub === "list" || sub === "ls") return list(deps, rest);
  if (sub === "get") return get(deps, rest);
  if (sub === "save") return save(deps, rest);
  throw usageError(sub ? `Unknown agents command ${sub}.\n${agentsUsage}` : agentsUsage);
}
