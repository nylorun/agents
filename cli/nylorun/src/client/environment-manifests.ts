/**
 * `nylorun environments manifests`: the Tenant's environment manifests (protocol 14, D63), named
 * and versioned definitions of a kind of Environment, saved like agents. `save` reads each JSON
 * file (its `$schema` is dropped), turns a `files` entry with `from` (a folder, relative to the
 * file) into files by content hash and uploads those the Runtime lacks, then saves the next
 * version under `If-Match` when `--if-match` is given. `--dry-run` prints the plan and exits 1
 * when the Runtime would refuse the save.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { environmentFiles, type EnvironmentManifestInput } from "@nylorun/agents";
import type { EnvironmentManifestPlan } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import {
  integerFlag,
  parseFlags,
  positional,
  printJson,
  printTable,
  readJson,
  runtimeCall,
  runtimeClient,
  usageError,
} from "./runtime.js";

export const manifestsUsage = `  manifests list [--json]             each environment manifest's latest version
  manifests get <name> [--version <n>]
                                      a manifest's latest version (or version n), as JSON
  manifests versions <name>           its versions, with the Environments made from each
  manifests save <manifest.json>... [--if-match <n>] [--dry-run]
                                      save each manifest's next version (a files entry with
                                      "from": a folder beside the file, uploaded by hash);
                                      --dry-run prints the plan and saves nothing
  manifests rm <name>                 delete every version (refused while an Environment
                                      was made from one)`;

/** Each file under `dir`, by its path relative to it (`/`-separated). */
async function folderOf(dir: string): Promise<Record<string, Uint8Array>> {
  const found: Record<string, Uint8Array> = {};
  const visit = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found[relative(dir, path).split(sep).join("/")] = new Uint8Array(await readFile(path));
    }
  };
  try {
    await visit(dir);
  } catch (error) {
    throw new CliError(`Cannot read ${dir}: ${(error as Error).message}`, 1);
  }
  if (Object.keys(found).length === 0) throw new CliError(`${dir} holds no files.`, 1);
  return found;
}

/** The manifest in `path`, its `from` folders hashed: the body to save and the bytes to upload. */
export async function manifestFrom(
  path: string,
): Promise<{ manifest: EnvironmentManifestInput; bytes: Record<string, Uint8Array> }> {
  const raw = await readJson(path, "The manifest");
  if (typeof raw.name !== "string" || raw.name === "") throw usageError(`${path}: the manifest has no name.`);
  const bytes: Record<string, Uint8Array> = {};
  const files = Array.isArray(raw.files) ? (raw.files as Record<string, unknown>[]) : undefined;
  const entries = [];
  for (const entry of files ?? []) {
    if (typeof entry?.from !== "string") {
      entries.push(entry);
      continue;
    }
    const { from, ...rest } = entry;
    if (typeof rest.path !== "string") throw usageError(`${path}: a files entry with from needs a path.`);
    const folder = await environmentFiles(rest.path, await folderOf(resolve(dirname(path), from)));
    Object.assign(bytes, folder.bytes);
    entries.push({ ...rest, files: folder.entry.files });
  }
  const { $schema: _schema, ...manifest } = raw;
  return {
    manifest: (files === undefined ? manifest : { ...manifest, files: entries }) as unknown as EnvironmentManifestInput,
    bytes,
  };
}

async function save(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments manifests save <manifest.json>... [--if-match <n>] [--dry-run]";
  const flags = parseFlags(args, { booleans: ["--dry-run"], values: ["--if-match"] }, usage);
  if (flags.rest.length === 0) throw usageError(`Usage: ${usage}`);
  const ifMatch = integerFlag(flags, "--if-match");
  if (ifMatch !== undefined && flags.rest.length > 1) throw usageError("--if-match takes one manifest.");
  const { client, connection } = await runtimeClient(deps, flags);
  let blocked = false;
  for (const path of flags.rest) {
    const { manifest, bytes } = await manifestFrom(path);
    const options = { files: bytes, ...(ifMatch === undefined ? {} : { ifMatch }) };
    if (flags.booleans.has("--dry-run")) {
      const plan: EnvironmentManifestPlan = await runtimeCall(() => client.environments.manifests.plan(manifest, options));
      printJson(deps, plan);
      if (plan.errors.length > 0) blocked = true;
      continue;
    }
    const saved = await runtimeCall(() => client.environments.manifests.save(manifest, options));
    deps.err(
      saved.unchanged
        ? `Environment manifest ${saved.manifest.name} is unchanged at version ${saved.manifest.version} on ${connection.label}.`
        : `Saved environment manifest ${saved.manifest.name} version ${saved.manifest.version} on ${connection.label}.`,
    );
    for (const warning of saved.warnings) deps.err(`  warning: ${warning.message}`);
    printJson(deps, saved);
  }
  return blocked ? 1 : 0;
}

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments manifests list [--json]";
  const flags = parseFlags(args, { booleans: ["--json"] }, usage);
  positional(flags, 0, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const manifests = await runtimeCall(() => client.environments.manifests.list());
  if (flags.booleans.has("--json")) {
    printJson(deps, manifests);
    return 0;
  }
  if (manifests.length === 0) deps.out(`No environment manifests on ${connection.label}.`);
  else
    printTable(deps, [
      ["NAME", "VERSION", "KIND", "ENVIRONMENTS", "SAVED BY"],
      ...manifests.map((manifest) => [
        manifest.name,
        String(manifest.version),
        manifest.manifest.kind ?? "virtual",
        String(manifest.environments),
        manifest.savedBy.actor,
      ]),
    ]);
  return 0;
}

async function get(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments manifests get <name> [--version <n>]";
  const flags = parseFlags(args, { values: ["--version"] }, usage);
  const [name] = positional(flags, 1, usage);
  const version = integerFlag(flags, "--version");
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.environments.manifests.get(name!, version === undefined ? {} : { version })));
  return 0;
}

async function versions(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments manifests versions <name>";
  const flags = parseFlags(args, {}, usage);
  const [name] = positional(flags, 1, usage);
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.environments.manifests.versions(name!)));
  return 0;
}

async function remove(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments manifests rm <name>";
  const flags = parseFlags(args, {}, usage);
  const [name] = positional(flags, 1, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const deleted = await runtimeCall(() => client.environments.manifests.delete(name!));
  if (!deleted.deleted) {
    deps.err(`No environment manifest ${name} on ${connection.label}.`);
    return 1;
  }
  deps.out(`Deleted environment manifest ${name}: every version.`);
  return 0;
}

const COMMANDS: Record<string, (deps: StackDeps, args: readonly string[]) => Promise<number>> = {
  list,
  ls: list,
  get,
  versions,
  save,
  rm: remove,
  delete: remove,
};

/** `nylorun environments manifests <command> ...` */
export async function manifestsCommand(deps: StackDeps, args: readonly string[], usage: string): Promise<number> {
  const [sub, ...rest] = args;
  const command = sub !== undefined && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!command) throw usageError(`Usage: nylorun environments manifests <list|get|versions|save|rm> …\n\n${usage}`);
  return command(deps, rest);
}
