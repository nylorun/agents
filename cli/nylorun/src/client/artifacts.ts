/**
 * `nylorun artifacts`: the Tenant's file artifacts (`/v1/artifacts`, Runtime API): upload a file
 * (to name in a message with `sessions send --file`), list, download, browse a folder artifact
 * (an Environment's disk), share a version with a capability link, and delete.
 */
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StackDeps } from "../stack/commands.js";
import {
  integerFlag,
  labelsOf,
  parseFlags,
  positional,
  printCursor,
  printJson,
  printTable,
  readStdin,
  runtimeCall,
  runtimeClient,
  runtimeFlagsUsage,
  usageError,
} from "./runtime.js";

export const artifactsUsage = `nylorun artifacts <command>

The Tenant's file artifacts, through the Runtime API with an application key (or NYLORUN_TOKEN).

  list [--session <id>] [--label <key=value>]... [--limit <n>] [--cursor <c>] [--json]
                                      newest first: id, kind, name, latest version, owner
  get <id>                            the artifact and its versions, as JSON
  upload <file|-> [--name <name>] [--content-type <type>] [--session <id>] [--label <key=value>]...
                                      upload a file as a new artifact (--to <id>: as its next
                                      version); prints its id
  download <id> [--version <n>] [--output <file>]
                                      the bytes, to a file or standard output
  tree <id> [--version <n>]           a folder artifact's files
  diff <id> [--version <n>] [--from <n>]
                                      what changed between two versions of a folder
  zip <id> [--version <n>] --output <file>
                                      a folder artifact as a zip
  link <id> [--version <n>] [--expires-in <s>] [--file <path>]
                                      a capability link anyone holding it may download
  rm <id>                             delete the artifact and its versions

${runtimeFlagsUsage}`;

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts list [--session <id>] [--label <key=value>]... [--limit <n>] [--cursor <c>] [--json]";
  const flags = parseFlags(
    args,
    { booleans: ["--json"], values: ["--session", "--limit", "--cursor"], lists: ["--label"] },
    usage,
  );
  positional(flags, 0, usage);
  const sessionId = flags.values.get("--session");
  const cursor = flags.values.get("--cursor");
  const limit = integerFlag(flags, "--limit");
  const labels = labelsOf(flags);
  const { client } = await runtimeClient(deps, flags);
  const page = await runtimeCall(() =>
    client.artifacts.page({
      ...(sessionId ? { sessionId } : {}),
      ...(labels ? { labels } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor ? { cursor } : {}),
    }),
  );
  if (flags.booleans.has("--json")) {
    printJson(deps, page);
    return 0;
  }
  if (page.artifacts.length === 0) deps.out("No artifacts.");
  else
    printTable(deps, [
      ["ID", "KIND", "NAME", "VERSION", "OWNER"],
      ...page.artifacts.map((item) => [
        item.artifactId,
        item.kind,
        item.name,
        String(item.latestVersion),
        item.sessionId
          ? `session ${item.sessionId}`
          : item.environmentId
            ? `environment ${item.environmentId}`
            : "tenant",
      ]),
    ]);
  printCursor(deps, page.nextCursor);
  return 0;
}

async function get(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts get <id>";
  const flags = parseFlags(args, {}, usage);
  const [id] = positional(flags, 1, usage);
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.artifacts.get(id!)));
  return 0;
}

async function upload(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun artifacts upload <file|-> [--name <name>] [--content-type <type>] [--session <id>] [--label <key=value>]... [--to <id>]";
  const flags = parseFlags(
    args,
    { values: ["--name", "--content-type", "--session", "--to"], lists: ["--label"] },
    usage,
  );
  const [path] = positional(flags, 1, usage);
  const to = flags.values.get("--to");
  const name = flags.values.get("--name") ?? (path === "-" ? undefined : basename(path!));
  if (!to && !name) throw usageError("Name the file with --name when it comes from standard input.");
  if (to && (flags.values.has("--name") || flags.values.has("--session") || flags.lists.has("--label")))
    throw usageError("--to uploads a version: --name, --session and --label belong to the artifact.");
  const bytes = new Uint8Array(path === "-" ? await readStdin() : await readFile(path!));
  const contentType = flags.values.get("--content-type");
  const sessionId = flags.values.get("--session");
  const labels = labelsOf(flags);
  const { client } = await runtimeClient(deps, flags);
  const uploaded = await runtimeCall(() =>
    to
      ? client.artifacts.uploadVersion(to, bytes, contentType ? { contentType } : {})
      : client.artifacts.upload(bytes, {
          name: name!,
          ...(contentType ? { contentType } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(labels ? { labels } : {}),
        }),
  );
  deps.err(`Uploaded ${uploaded.artifact.name}: version ${uploaded.version.version} of artifact ${uploaded.artifact.artifactId}.`);
  deps.out(uploaded.artifact.artifactId);
  return 0;
}

/** Writes `response`'s body to `output`, or to standard output. */
async function save(response: Response, output: string | undefined): Promise<void> {
  if (!response.body) return;
  const source = Readable.fromWeb(response.body as never);
  await pipeline(source, output === undefined ? process.stdout : createWriteStream(output));
}

async function download(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts download <id> [--version <n>] [--output <file>]";
  const flags = parseFlags(args, { values: ["--version", "--output"] }, usage);
  const [id] = positional(flags, 1, usage);
  const version = integerFlag(flags, "--version");
  const { client } = await runtimeClient(deps, flags);
  const response = await runtimeCall(() =>
    client.artifacts.download(id!, version === undefined ? {} : { version }),
  );
  await save(response, flags.values.get("--output"));
  return 0;
}

async function tree(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts tree <id> [--version <n>]";
  const flags = parseFlags(args, { values: ["--version"] }, usage);
  const [id] = positional(flags, 1, usage);
  const version = integerFlag(flags, "--version");
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.artifacts.tree(id!, version === undefined ? {} : { version })));
  return 0;
}

async function diff(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts diff <id> [--version <n>] [--from <n>]";
  const flags = parseFlags(args, { values: ["--version", "--from"] }, usage);
  const [id] = positional(flags, 1, usage);
  const version = integerFlag(flags, "--version");
  const from = integerFlag(flags, "--from");
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() =>
      client.artifacts.diff(id!, {
        ...(version === undefined ? {} : { version }),
        ...(from === undefined ? {} : { from }),
      }),
    ),
  );
  return 0;
}

async function zip(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts zip <id> [--version <n>] --output <file>";
  const flags = parseFlags(args, { values: ["--version", "--output"] }, usage);
  const [id] = positional(flags, 1, usage);
  const output = flags.values.get("--output");
  if (!output) throw usageError(`Usage: ${usage}`);
  const version = integerFlag(flags, "--version");
  const { client } = await runtimeClient(deps, flags);
  const response = await runtimeCall(() => client.artifacts.zip(id!, version === undefined ? {} : { version }));
  await save(response, output);
  return 0;
}

async function link(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts link <id> [--version <n>] [--expires-in <s>] [--file <path>]";
  const flags = parseFlags(args, { values: ["--version", "--expires-in", "--file"] }, usage);
  const [id] = positional(flags, 1, usage);
  const version = integerFlag(flags, "--version");
  const expiresIn = integerFlag(flags, "--expires-in");
  const file = flags.values.get("--file");
  const { client } = await runtimeClient(deps, flags);
  const created = await runtimeCall(() =>
    client.artifacts.link(id!, {
      ...(version === undefined ? {} : { version }),
      ...(expiresIn === undefined ? {} : { expiresIn }),
      ...(file ? { file } : {}),
    }),
  );
  deps.err(JSON.stringify(created));
  deps.out(created.url);
  return 0;
}

async function rm(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun artifacts rm <id>";
  const flags = parseFlags(args, {}, usage);
  const [id] = positional(flags, 1, usage);
  const { client } = await runtimeClient(deps, flags);
  await runtimeCall(() => client.artifacts.delete(id!));
  deps.out(`Deleted artifact ${id}.`);
  return 0;
}

const COMMANDS: Record<string, (deps: StackDeps, args: readonly string[]) => Promise<number>> = {
  list,
  ls: list,
  get,
  upload,
  download,
  tree,
  diff,
  zip,
  link,
  rm,
  delete: rm,
};

/** `nylorun artifacts <command> ...` */
export async function artifactsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    deps.out(artifactsUsage);
    return 0;
  }
  const command = sub !== undefined && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!command) throw usageError(sub ? `Unknown artifacts command ${sub}.\n${artifactsUsage}` : artifactsUsage);
  return command(deps, rest);
}

