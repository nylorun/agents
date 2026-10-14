/**
 * `nylorun environments`: the Tenant's Environments (protocol 11: each holds one sandbox and one
 * vault), through the Runtime API of the installation `target.ts` picks: create or find one by
 * id, from an environment manifest or inline fields (protocol 14: what it runs never changes),
 * fork it onto a new manifest version, stop, reset or delete it, keep and restore versions of
 * its disk, and write its secrets; and the environment manifests themselves
 * (`environment-manifests.ts`). A secret's value comes from a file or standard input, never from
 * the command line, and no command reads one back. None of them starts a local Tenant.
 */
import type { EnvironmentEventType } from "@nylorun/core/contracts";
import type { EnvironmentView } from "@nylorun/agents";
import type { StackDeps } from "../stack/commands.js";
import { manifestsCommand, manifestsUsage } from "./environment-manifests.js";
import { readSecret } from "./io.js";
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

  list [--label <key=value>]... [--behind] [--limit <n>] [--cursor <c>] [--json]
                                      id, kind, manifest, state, sessions and labels;
                                      --behind: those made from an older manifest version
  get <id>                            the Environment, as JSON
  put <id> --manifest <name[@n]> [--label <key=value>]...
  put <id> [<inline.json|->] [--kind <virtual|pod|none>] [--label <key=value>]...
                                      create it from a manifest (its latest version, or n)
                                      or inline fields, or find it and change its labels
                                      (what it runs never changes: fork it for that)
  fork <id> <new-id> [--manifest <name[@n]>] [--disk <latest|n|empty>]
       [--secrets <copy|none>] [--label <key=value>]... [--dry-run]
                                      a new Environment from a manifest version (default
                                      its manifest's latest), with this one's disk and the
                                      secrets it declares; --dry-run prints the plan
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
  secrets put <id> <name>             the value of a slot its manifest declares, piped in
                                      on standard input
  secrets put <id> <name> <secret.json|->
                                      create or replace a secret: {"type": "bearer", ...}, read
                                      from a file or standard input
  secrets rm <id> <name>
${manifestsUsage}

${runtimeFlagsUsage}`;

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments list [--label <key=value>]... [--behind] [--limit <n>] [--cursor <c>] [--json]";
  const flags = parseFlags(
    args,
    { booleans: ["--json", "--behind"], values: ["--limit", "--cursor"], lists: ["--label"] },
    usage,
  );
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
  let environments = page.environments as EnvironmentView[];
  if (flags.booleans.has("--behind")) {
    // Made from a manifest version older than its latest: fork them to move on (D63).
    const latest = new Map(
      (await runtimeCall(() => client.environments.manifests.list())).map((manifest) => [manifest.name, manifest.version]),
    );
    environments = environments.filter(
      (environment) =>
        environment.manifestName !== undefined &&
        (environment.manifestVersion ?? 0) < (latest.get(environment.manifestName) ?? 0),
    );
  }
  if (flags.booleans.has("--json")) {
    printJson(deps, paged ? page : environments);
    return 0;
  }
  if (environments.length === 0) deps.out(`No Environments on ${connection.label}.`);
  else
    printTable(deps, [
      ["ID", "KIND", "MANIFEST", "STATE", "SESSIONS", "LABELS"],
      ...environments.map((environment) => [
        environment.id,
        environment.kind,
        environment.manifestName === undefined ? "-" : `${environment.manifestName}@${environment.manifestVersion}`,
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
  const usage =
    "nylorun environments put <id> [--manifest <name[@n]> | <inline.json|-> [--kind <virtual|pod|none>]] [--label <key=value>]...";
  const flags = parseFlags(args, { values: ["--kind", "--manifest"], lists: ["--label"] }, usage);
  if (flags.rest.length < 1 || flags.rest.length > 2) throw usageError(`Usage: ${usage}`);
  const [id, path] = flags.rest as [string, string | undefined];
  const manifest = flags.values.get("--manifest");
  const kind = flags.values.get("--kind");
  if (manifest !== undefined && (path !== undefined || kind !== undefined))
    throw usageError("--manifest makes it from the manifest: give no inline fields or --kind with it.");
  const recipe = path === undefined ? {} : await readJson(path, "The inline fields");
  const labels = labelsOf(flags);
  const body = {
    ...recipe,
    ...(manifest ? { manifest } : {}),
    ...(kind ? { kind } : {}),
    ...(labels ? { labels: { ...(recipe.labels as Record<string, string> | undefined), ...labels } } : {}),
  };
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.environments.put(id, body as never)));
  return 0;
}

async function fork(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun environments fork <id> <new-id> [--manifest <name[@n]>] [--disk <latest|n|empty>] [--secrets <copy|none>] [--label <key=value>]... [--dry-run]";
  const flags = parseFlags(
    args,
    { booleans: ["--dry-run"], values: ["--manifest", "--disk", "--secrets"], lists: ["--label"] },
    usage,
  );
  const [id, next] = positional(flags, 2, usage);
  const disk = flags.values.get("--disk");
  if (disk !== undefined && disk !== "latest" && disk !== "empty" && !/^[1-9]\d*$/.test(disk))
    throw usageError("--disk is latest, empty or a version number.");
  const secrets = flags.values.get("--secrets");
  if (secrets !== undefined && secrets !== "copy" && secrets !== "none") throw usageError("--secrets is copy or none.");
  const manifest = flags.values.get("--manifest");
  const labels = labelsOf(flags);
  const options = {
    id: next!,
    ...(manifest ? { manifest } : {}),
    ...(disk === undefined ? {} : { disk: disk === "latest" || disk === "empty" ? (disk as "latest" | "empty") : Number(disk) }),
    ...(secrets ? { secrets: secrets as "copy" | "none" } : {}),
    ...(labels ? { labels } : {}),
  };
  const { client, connection } = await runtimeClient(deps, flags);
  if (flags.booleans.has("--dry-run")) {
    printJson(deps, await runtimeCall(() => client.environments.planFork(id!, options)));
    return 0;
  }
  const forked = await runtimeCall(() => client.environments.fork(id!, options));
  const { plan } = forked;
  deps.err(
    `Forked Environment ${id} into ${next} on ${connection.label}: ${plan.manifest ? `${plan.manifest.name}@${plan.manifest.version}` : "its fields"}, ${
      plan.disk === null ? "an empty disk" : `disk version ${plan.disk}`
    }, ${plan.secrets.copied.length} secrets copied${plan.setup ? "; its setup runs before the first turn" : ""}.`,
  );
  if (plan.secrets.missing.length > 0)
    deps.err(`  set before use: ${plan.secrets.missing.join(", ")} (nylorun environments secrets put ${next} <name>)`);
  printJson(deps, forked);
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
    const usage = "nylorun environments secrets put <id> <name> [<secret.json|->]";
    const flags = parseFlags(rest, {}, usage);
    if (flags.rest.length < 2 || flags.rest.length > 3) throw usageError(`Usage: ${usage}`);
    const [id, name, path] = flags.rest as [string, string, string | undefined];
    if (path === undefined) {
      // A slot its manifest declares (D64): the value only, piped in; the binding is the slot's.
      const value = await readSecret(deps, `value of ${name}`, `printf %s "$TOKEN" | nylorun environments secrets put ${id} ${name}`);
      const { client } = await runtimeClient(deps, flags);
      printJson(deps, await runtimeCall(() => client.environments.secrets.put(id, name, { value })));
      return 0;
    }
    const secret = await readJson(path, "The secret");
    if (typeof secret.type !== "string") throw usageError('The secret needs a "type".');
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.environments.secrets.put(id, name, secret as never)));
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
  fork,
  manifests: (deps, args) => manifestsCommand(deps, args, manifestsUsage),
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
