/**
 * `nylorun sessions`: the Tenant's sessions (`/v1/sessions`, Runtime API): open one on an Agent
 * (protocol 16: every session runs on one, and its id is the caller's to choose), send it a
 * message, answer what it waits for, watch its events, and read its history, usage, calls and
 * traces. `exec` runs a command in the session's sandbox, as an app's own tool would.
 */
import { randomUUID } from "node:crypto";
import type { JsonValue, MessagePart } from "@nylorun/agents";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import {
  integerFlag,
  parseFlags,
  parseJsonArgument,
  positional,
  printCursor,
  printJson,
  printTable,
  runtimeCall,
  runtimeClient,
  runtimeFlagsUsage,
  usageError,
} from "./runtime.js";

export const sessionsUsage = `nylorun sessions <command>

The Tenant's sessions, through the Runtime API with an application key (or NYLORUN_TOKEN).

  list [--agent <id>] [--manifest <name>] [--status <status>] [--owner <user>]
       [--limit <n>] [--cursor <c>] [--json]
                                      --agent: on that Agent; --manifest: on the Agents made
                                      from that agent manifest
  create --agent <id> --owner <user> [--id <id>] [--info <json>]
                                      open a session on Agent <id>; prints its id
  get <id>                            the session: status, active turn, what it waits for
  send <id> [<text>] [--data <json>] [--file <artifact>[@<version>]]... [--idempotency-key <k>]
                                      start a turn with text, JSON data or files (artifacts)
  approve <id> <interaction> [--deny] approve (or deny) a held tool call
  respond <id> <interaction> <json>   answer a question the agent asked
  cancel <id> [--reason <text>]       cancel the running turn
  watch <id> [--follow] [--cursor <c>]
                                      the session's events as JSON lines until interrupted;
                                      --follow adds the sessions of agents it uses as tools
  history <id> [--agent <a>] [--limit <n>] [--cursor <c>]
  usage <id> [--turn <id>]            tokens and cost
  calls <id> [--tool] [--turn <id>] [--limit <n>] [--cursor <c>]
                                      model calls (--tool: tool calls)
  trace <id> <turn>                   the turn's spans as OTLP JSON
  exec <id> [--timeout <s>] -- <command>...
                                      run a command in the session's sandbox (bash); exits with
                                      its exit code

${runtimeFlagsUsage}`;

/** Protocol 16: a session runs on the Agent `--agent` names, which holds what an Environment did. */
const ENVIRONMENT_REMOVED =
  "--environment was removed in protocol 16: a session runs on an Agent, its sandbox and vault included. Pass --agent <id> (nylorun agents list).";

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun sessions list [--agent <id>] [--manifest <name>] [--status <s>] [--owner <user>] [--limit <n>] [--cursor <c>] [--json]";
  if (args.includes("--environment")) throw usageError(ENVIRONMENT_REMOVED);
  const flags = parseFlags(
    args,
    { booleans: ["--json"], values: ["--agent", "--manifest", "--status", "--owner", "--limit", "--cursor"] },
    usage,
  );
  positional(flags, 0, usage);
  const { client } = await runtimeClient(deps, flags);
  const value = (name: string) => flags.values.get(name);
  const limit = integerFlag(flags, "--limit");
  const page = await runtimeCall(() =>
    client.sessions.page({
      ...(value("--agent") ? { agentId: value("--agent") } : {}),
      ...(value("--status") ? { status: value("--status") as never } : {}),
      ...(value("--manifest") ? { manifest: value("--manifest") } : {}),
      ...(value("--owner") ? { ownerUserId: value("--owner") } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(value("--cursor") ? { cursor: value("--cursor") } : {}),
    }),
  );
  if (flags.booleans.has("--json")) {
    printJson(deps, page);
    return 0;
  }
  if (page.sessions.length === 0) deps.out("No sessions.");
  else
    printTable(deps, [
      ["ID", "AGENT", "OWNER", "STATUS", "LAST EVENT"],
      ...page.sessions.map((session) => [
        session.id,
        session.agentId,
        session.ownerUserId,
        session.status,
        session.lastEventAt ?? "-",
      ]),
    ]);
  printCursor(deps, page.nextCursor);
  return 0;
}

async function create(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions create --agent <id> --owner <user> [--id <id>] [--info <json>]";
  if (args.includes("--environment")) throw usageError(ENVIRONMENT_REMOVED);
  const flags = parseFlags(args, { values: ["--agent", "--owner", "--id", "--info"] }, usage);
  positional(flags, 0, usage);
  const agentId = flags.values.get("--agent");
  const ownerUserId = flags.values.get("--owner");
  if (!agentId || !ownerUserId) throw usageError(`Usage: ${usage}`);
  const info = flags.values.get("--info");
  const parsedInfo = info === undefined ? undefined : parseJsonArgument(info, "--info");
  if (parsedInfo !== undefined && (!parsedInfo || typeof parsedInfo !== "object" || Array.isArray(parsedInfo)))
    throw usageError("--info must be a JSON object.");
  const id = flags.values.get("--id");
  const { client } = await runtimeClient(deps, flags);
  const session = await runtimeCall(() =>
    client.createSession({
      agent: agentId,
      ownerUserId,
      ...(id ? { id } : {}),
      ...(parsedInfo ? { info: parsedInfo as Record<string, unknown> } : {}),
    }),
  );
  deps.out(session.id);
  return 0;
}

async function get(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions get <id>";
  const flags = parseFlags(args, {}, usage);
  const [id] = positional(flags, 1, usage);
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.session(id!).inspect()));
  return 0;
}

/** `artifact` or `artifact@version`, as a file part. */
function filePart(value: string): MessagePart {
  const at = value.lastIndexOf("@");
  if (at <= 0) return { type: "file", artifactId: value };
  const version = value.slice(at + 1);
  if (!/^[1-9]\d*$/.test(version)) throw usageError(`--file ${value}: the version must be a positive number.`);
  return { type: "file", artifactId: value.slice(0, at), version: Number(version) };
}

async function send(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun sessions send <id> [<text>] [--data <json>] [--file <artifact>[@<version>]]... [--idempotency-key <k>]";
  const flags = parseFlags(args, { values: ["--data", "--idempotency-key"], lists: ["--file"] }, usage);
  if (flags.rest.length < 1 || flags.rest.length > 2) throw usageError(`Usage: ${usage}`);
  const [id, text] = flags.rest as [string, string | undefined];
  const data = flags.values.get("--data");
  const files = flags.lists.get("--file") ?? [];
  if (data !== undefined && (text !== undefined || files.length))
    throw usageError("--data is a message of its own: pass it without text or --file.");
  if (data === undefined && text === undefined && files.length === 0)
    throw usageError(`Nothing to send. Usage: ${usage}`);
  const parts = files.map(filePart);
  const options = { idempotencyKey: flags.values.get("--idempotency-key") ?? randomUUID() };
  const { client } = await runtimeClient(deps, flags);
  const session = client.session(id);
  const accepted = await runtimeCall(() =>
    data !== undefined
      ? session.input(parseJsonArgument(data, "--data") as JsonValue, options)
      : parts.length
        ? session.inputParts([...(text ? [{ type: "text" as const, text }] : []), ...parts], options)
        : session.input(text!, options),
  );
  printJson(deps, accepted);
  return 0;
}

async function approve(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions approve <id> <interaction> [--deny]";
  const flags = parseFlags(args, { booleans: ["--deny"] }, usage);
  const [id, interaction] = positional(flags, 2, usage);
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() =>
      client.session(id!).approve(interaction!, !flags.booleans.has("--deny"), { idempotencyKey: randomUUID() }),
    ),
  );
  return 0;
}

async function respond(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions respond <id> <interaction> <json>";
  const flags = parseFlags(args, {}, usage);
  const [id, interaction, value] = positional(flags, 3, usage);
  const answer = parseJsonArgument(value!, "The answer") as JsonValue;
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() => client.session(id!).respond(interaction!, answer, { idempotencyKey: randomUUID() })),
  );
  return 0;
}

async function cancel(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions cancel <id> [--reason <text>]";
  const flags = parseFlags(args, { values: ["--reason"] }, usage);
  const [id] = positional(flags, 1, usage);
  const reason = flags.values.get("--reason");
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() =>
      client.session(id!).cancel({ idempotencyKey: randomUUID(), ...(reason ? { reason } : {}) }),
    ),
  );
  return 0;
}

async function watch(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions watch <id> [--follow] [--cursor <c>]";
  const flags = parseFlags(args, { booleans: ["--follow"], values: ["--cursor"] }, usage);
  const [id] = positional(flags, 1, usage);
  const cursor = flags.values.get("--cursor");
  const { client } = await runtimeClient(deps, flags);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runtimeCall(async () => {
      for await (const event of client.session(id!).observe({
        follow: flags.booleans.has("--follow"),
        signal: controller.signal,
        ...(cursor ? { cursor } : {}),
      }))
        deps.out(JSON.stringify(event));
    });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}

async function history(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions history <id> [--agent <a>] [--limit <n>] [--cursor <c>]";
  const flags = parseFlags(args, { values: ["--agent", "--limit", "--cursor"] }, usage);
  const [id] = positional(flags, 1, usage);
  const limit = integerFlag(flags, "--limit");
  const agent = flags.values.get("--agent");
  const cursor = flags.values.get("--cursor");
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() =>
      client.session(id!).history({
        ...(agent ? { agent } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit === undefined ? {} : { limit }),
      }),
    ),
  );
  return 0;
}

async function usageOf(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions usage <id> [--turn <id>]";
  const flags = parseFlags(args, { values: ["--turn"] }, usage);
  const [id] = positional(flags, 1, usage);
  const turnId = flags.values.get("--turn");
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.session(id!).usage(turnId ? { turnId } : {})));
  return 0;
}

async function calls(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions calls <id> [--tool] [--turn <id>] [--limit <n>] [--cursor <c>]";
  const flags = parseFlags(args, { booleans: ["--tool"], values: ["--turn", "--limit", "--cursor"] }, usage);
  const [id] = positional(flags, 1, usage);
  const turnId = flags.values.get("--turn");
  const cursor = flags.values.get("--cursor");
  const limit = integerFlag(flags, "--limit");
  const options = {
    ...(turnId ? { turnId } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  };
  const { client } = await runtimeClient(deps, flags);
  const session = client.session(id!);
  const page = flags.booleans.has("--tool")
    ? await runtimeCall(() => session.toolCalls(options))
    : await runtimeCall(() => session.modelCalls(options));
  printJson(deps, page);
  return 0;
}

async function trace(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions trace <id> <turn>";
  const flags = parseFlags(args, {}, usage);
  const [id, turn] = positional(flags, 2, usage);
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.session(id!).trace(turn!)));
  return 0;
}

async function exec(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun sessions exec <id> [--timeout <s>] -- <command>...";
  const split = args.indexOf("--");
  if (split < 0 || split === args.length - 1) throw usageError(`Usage: ${usage}`);
  const flags = parseFlags(args.slice(0, split), { values: ["--timeout"] }, usage);
  const [id] = positional(flags, 1, usage);
  const timeout = integerFlag(flags, "--timeout");
  const command = args.slice(split + 1).join(" ");
  const { client } = await runtimeClient(deps, flags);
  // The Runtime answers the tool's outcome: `completed` with its output, or why it did not run.
  const outcome = (await runtimeCall(() =>
    client.session(id!).sandbox.bash({ command, ...(timeout === undefined ? {} : { timeout }) }),
  )) as { kind?: string; output?: unknown; error?: { message?: string } };
  if (outcome.kind !== "completed")
    throw new CliError(
      `The command did not run (${outcome.kind ?? "no outcome"}): ${outcome.error?.message ?? JSON.stringify(outcome)}`,
      1,
    );
  const result = outcome.output as { exitCode?: number; stdout?: string; stderr?: string };
  if (result.stdout) deps.out(result.stdout.replace(/\n$/, ""));
  if (result.stderr) deps.err(result.stderr.replace(/\n$/, ""));
  return typeof result.exitCode === "number" ? result.exitCode : 0;
}

const COMMANDS: Record<string, (deps: StackDeps, args: readonly string[]) => Promise<number>> = {
  list,
  ls: list,
  create,
  get,
  send,
  approve,
  respond,
  cancel,
  watch,
  history,
  usage: usageOf,
  calls,
  trace,
  exec,
};

/** `nylorun sessions <command> ...` */
export async function sessionsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    deps.out(sessionsUsage);
    return 0;
  }
  const command = sub !== undefined && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!command) throw usageError(sub ? `Unknown sessions command ${sub}.\n${sessionsUsage}` : sessionsUsage);
  return command(deps, rest);
}
