/**
 * `nylorun environments`: the Tenant's Environments (protocol 11: each holds one sandbox and one
 * vault), through the Runtime API of the installation `target.ts` picks: create or find one by
 * id (protocol 14: what it runs never changes), stop, reset or delete it, keep and restore versions of its disk, and write its secrets. A
 * secret's value comes from a file or standard input, never from the command line, and no
 * command reads one back. None of them starts a local Tenant.
 */
import type { EnvironmentEventType } from "@nylorun/core/contracts";
import type { EnvironmentView } from "@nylorun/agents";
import type { StackDeps } from "../stack/commands.js";
import {
  integerFlag,
  labelsOf,
  parseFlags,
  positional,
  printCursor,
  printJson,
  printTable,
  readJson,
  runtimeCall,
  runtimeClient,
  runtimeFlagsUsage,
  usageError,
} from "./runtime.js";

export const environmentsUsage = `nylorun environments <command>

The Tenant's Environments (one sandbox and one vault each), through the Runtime API with an
application key (or NYLORUN_TOKEN).

  list [--label <key=value>]... [--limit <n>] [--cursor <c>] [--json]
                                      id, kind, state, sessions and labels
  get <id>                            the Environment, as JSON
  put <id> [<recipe.json|->] [--kind <virtual|pod|none>] [--label <key=value>]...
                                      create it, or find it and change its labels (what
                                      it runs never changes: fork it for that)
  stop <id> | reset <id>              stop its sandbox; reset its disk
  delete <id>                         delete it: its sandbox, files and vault (refused while a
                                      turn runs in it)
  snapshot <id>                       keep a version of its disk
  versions <id>                       its disk versions
  restore <id> <version|latest>       put a version of its disk back
  delete-version <id> <version>
  events <id> [--from <n>] [--types <type,…>] [--since <time>] [--until <time>]
                                      its events (lifecycle, and environment.egress for every
                                      connection, naming the turns running), as JSON
  secrets list <id>                   its secrets' names, types and bindings (never a value)
  secrets get <id> <name>
  secrets put <id> <name> <secret.json|->
                                      create or replace a secret: {"type": "bearer", ...}, read
                                      from a file or standard input
  secrets rm <id> <name>

${runtimeFlagsUsage}`;

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments list [--label <key=value>]... [--limit <n>] [--cursor <c>] [--json]";
  const flags = parseFlags(args, { booleans: ["--json"], values: ["--limit", "--cursor"], lists: ["--label"] }, usage);
  positional(flags, 0, usage);
  const labels = labelsOf(flags);
  const limit = integerFlag(flags, "--limit");
  const cursor = flags.values.get("--cursor");
  const { client, connection } = await runtimeClient(deps, flags);
  const paged = limit !== undefined || cursor !== undefined;
  const page = paged
    ? await runtimeCall(() =>
        client.environments.page({
          ...(labels ? { labels } : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor ? { cursor } : {}),
        }),
      )
    : {
        environments: await runtimeCall(() => client.environments.list(labels ? { labels } : {})),
        nextCursor: null,
      };
  const environments = page.environments as EnvironmentView[];
  if (flags.booleans.has("--json")) {
    printJson(deps, paged ? page : environments);
    return 0;
  }
  if (environments.length === 0) deps.out(`No Environments on ${connection.label}.`);
  else
    printTable(deps, [
      ["ID", "KIND", "STATE", "SESSIONS", "LABELS"],
      ...environments.map((environment) => [
        environment.id,
        environment.kind,
        environment.state,
        String(environment.sessions.length),
        Object.entries(environment.labels)
          .map(([key, value]) => `${key}=${value}`)
          .join(",") || "-",
      ]),
    ]);
  printCursor(deps, page.nextCursor);
  return 0;
}

/** A command that takes one Environment id and prints the Runtime's answer. */
function byId(
  name: string,
  call: (client: Awaited<ReturnType<typeof runtimeClient>>["client"], id: string) => Promise<unknown>,
) {
  return async (deps: StackDeps, args: readonly string[]): Promise<number> => {
    const usage = `nylorun environments ${name} <id>`;
    const flags = parseFlags(args, {}, usage);
    const [id] = positional(flags, 1, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => call(client, id!)));
    return 0;
  };
}

async function put(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments put <id> [<recipe.json|->] [--kind <virtual|pod|none>] [--label <key=value>]...";
  const flags = parseFlags(args, { values: ["--kind"], lists: ["--label"] }, usage);
  if (flags.rest.length < 1 || flags.rest.length > 2) throw usageError(`Usage: ${usage}`);
  const [id, path] = flags.rest as [string, string | undefined];
  const recipe = path === undefined ? {} : await readJson(path, "The recipe");
  const kind = flags.values.get("--kind");
  const labels = labelsOf(flags);
  const body = {
    ...recipe,
    ...(kind ? { kind } : {}),
    ...(labels ? { labels: { ...(recipe.labels as Record<string, string> | undefined), ...labels } } : {}),
  };
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.environments.put(id, body as never)));
  return 0;
}

async function deleteEnvironment(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments delete <id>";
  const flags = parseFlags(args, {}, usage);
  const [id] = positional(flags, 1, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const deleted = await runtimeCall(async () => {
    try {
      return await client.environments.delete(id!);
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
  });
  if (!deleted || (deleted as { deleted?: boolean }).deleted === false) {
    deps.err(`No Environment ${id} on ${connection.label}.`);
    return 1;
  }
  deps.out(`Deleted Environment ${id}: its sandbox, files and vault.`);
  return 0;
}

async function restore(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments restore <id> <version|latest>";
  const flags = parseFlags(args, {}, usage);
  const [id, version] = positional(flags, 2, usage);
  if (version !== "latest" && !/^[1-9]\d*$/.test(version!))
    throw usageError("The version is a positive number or latest.");
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() => client.environments.restore(id!, version === "latest" ? "latest" : Number(version))),
  );
  return 0;
}

async function deleteVersion(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments delete-version <id> <version>";
  const flags = parseFlags(args, {}, usage);
  const [id, version] = positional(flags, 2, usage);
  if (!/^[1-9]\d*$/.test(version!)) throw usageError("The version is a positive number.");
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.environments.deleteVersion(id!, Number(version))));
  return 0;
}

async function events(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments events <id> [--from <n>] [--types <type,…>] [--since <time>] [--until <time>]";
  const flags = parseFlags(args, { values: ["--from", "--types", "--since", "--until"] }, usage);
  const [id] = positional(flags, 1, usage);
  const from = integerFlag(flags, "--from");
  const types = flags.values.get("--types")?.split(",").map((type) => type.trim()).filter(Boolean) as
    | EnvironmentEventType[]
    | undefined;
  const since = flags.values.get("--since");
  const until = flags.values.get("--until");
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() =>
      client.environments.events(id!, {
        ...(from === undefined ? {} : { from }),
        ...(types === undefined || types.length === 0 ? {} : { types }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
      }),
    ),
  );
  return 0;
}

async function secrets(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "list" || verb === "ls") {
    const usage = "nylorun environments secrets list <id>";
    const flags = parseFlags(rest, {}, usage);
    const [id] = positional(flags, 1, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.environments.secrets.list(id!)));
    return 0;
  }
  if (verb === "get") {
    const usage = "nylorun environments secrets get <id> <name>";
    const flags = parseFlags(rest, {}, usage);
    const [id, name] = positional(flags, 2, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.environments.secrets.get(id!, name!)));
    return 0;
  }
  if (verb === "put") {
    const usage = "nylorun environments secrets put <id> <name> <secret.json|->";
    const flags = parseFlags(rest, {}, usage);
    const [id, name, path] = positional(flags, 3, usage);
    const secret = await readJson(path!, "The secret");
    if (typeof secret.type !== "string") throw usageError('The secret needs a "type".');
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.environments.secrets.put(id!, name!, secret as never)));
    return 0;
  }
  if (verb === "rm" || verb === "delete") {
    const usage = "nylorun environments secrets rm <id> <name>";
    const flags = parseFlags(rest, {}, usage);
    const [id, name] = positional(flags, 2, usage);
    const { client } = await runtimeClient(deps, flags);
    await runtimeCall(() => client.environments.secrets.delete(id!, name!));
    deps.out(`Deleted secret ${name} of Environment ${id}.`);
    return 0;
  }
  throw usageError(`Usage: nylorun environments secrets <list|get|put|rm> …\n\n${environmentsUsage}`);
}

const COMMANDS: Record<string, (deps: StackDeps, args: readonly string[]) => Promise<number>> = {
  list,
  ls: list,
  get: byId("get", (client, id) => client.environments.get(id)),
  put,
  stop: byId("stop", (client, id) => client.environments.stop(id)),
  reset: byId("reset", (client, id) => client.environments.reset(id)),
  delete: deleteEnvironment,
  rm: deleteEnvironment,
  snapshot: byId("snapshot", (client, id) => client.environments.snapshot(id)),
  versions: byId("versions", (client, id) => client.environments.versions(id)),
  restore,
  "delete-version": deleteVersion,
  events,
  secrets,
};

/** `nylorun environments <command> ...` */
export async function environmentsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    deps.out(environmentsUsage);
    return 0;
  }
  const command = sub !== undefined && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!command)
    throw usageError(sub ? `Unknown environments command ${sub}.\n${environmentsUsage}` : environmentsUsage);
  return command(deps, rest);
}
