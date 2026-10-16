/**
 * `nylorun agents`: the Tenant's Agents (protocol 16: each is one version of an agent manifest
 * made live, with one environment and one vault, and the sessions that run on it), through the
 * Runtime API of the installation `target.ts` picks: create or find one by id from a saved
 * manifest, move it to another version (`pin`, `track`, `put`; track T3) and apply a pending one
 * (`restart`), fork it, stop, reset or delete it, keep and restore versions of its disk, and
 * write its secrets. The manifests themselves are `agent-manifests.ts`
 * and `apply.ts`. A secret's value comes from a file or standard input, never from the command
 * line, and no command reads one back. None of them starts a local Tenant.
 */
import type { AgentEventType, AgentView } from "@nylorun/agents";
import { parseAgentManifestRef } from "@nylorun/core/contracts";
import type { StackDeps } from "../stack/commands.js";
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

export const agentsUsage = `nylorun agents <command>

The Tenant's Agents (each one version of an agent manifest made live, with one environment and
one vault; sessions run on them), through the Runtime API with an application key (or
NYLORUN_TOKEN).

  list [--state <state>] [--manifest <name>] [--label <key=value>]... [--outdated]
       [--limit <n>] [--cursor <c>] [--json]
                                      id, manifest version (tracks or pinned, and the version
                                      it moves to), kind, state, sessions, owner and labels;
                                      --outdated (or --behind): those moving to another version
  get <id>                            the Agent, as JSON
  put <id> --manifest <name[@n]> [--owner <user>] [--label <key=value>]... [--dry-run]
                                      create it from a saved manifest (name tracks its latest
                                      version, name@n pins version n), or find it, change its
                                      owner and labels and move it to that version; --dry-run
                                      prints what the move would do
  pin <id> <version>                  move it to that version of its manifest, and keep it there
  track <id>                          move it to its manifest's latest version, and with each save
  restart <id> [--retry]              apply the version it waits to start on now (a running pod
                                      stops; the next turn starts it); --retry: the version that
                                      failed to start, again
  fork <id> <new-id> [--manifest <name[@n]>] [--disk <latest|n|empty>]
       [--secrets <copy|none>] [--label <key=value>]... [--dry-run]
                                      a new Agent from a manifest version (default its
                                      manifest's latest), with this one's disk and the secrets
                                      it declares; --dry-run prints the plan
  stop <id> | reset <id>              stop its sandbox; reset its disk
  rm <id>                             delete it: its sandbox, files and vault (refused while a
                                      turn runs on it)
  snapshot <id>                       keep a version of its disk
  versions <id>                       its disk versions
  restore <id> <version|latest>       put a version of its disk back
  delete-version <id> <version>
  events <id> [--from <n>] [--types <type,…>] [--since <time>] [--until <time>]
                                      its events (lifecycle, and agent.egress for every
                                      connection, naming the turns running), as JSON
  secrets list <id>                   its secrets' names, types and bindings (never a value)
  secrets get <id> <name>
  secrets put <id> <name>             the value of a slot its manifest declares, piped in
                                      on standard input
  secrets put <id> <name> <secret.json|->
                                      create or replace a secret: {"type": "bearer", ...}, read
                                      from a file or standard input
  secrets rm <id> <name>
  triggers list <id>                  its triggers: status, next and last run, as JSON
  triggers pause|resume <id> <trigger>
  triggers run <id> <trigger> [--idempotency-key <k>]
                                      run it once now, as if it fired
  triggers new-secret <id> <trigger>  a webhook trigger's new signing secret (whsec_…), shown
                                      once with its URL; the one before stops working
  runs <id> [--trigger <id>] [--limit <n>] [--cursor <c>]
                                      what each fire came to (started, queued, skipped,
                                      failed), newest first, as JSON

${runtimeFlagsUsage}`;

/** What `agents save` (a definition, before protocol 16) says now. */
const SAVE_REMOVED =
  "nylorun agents save was removed in protocol 16: agents run from saved agent manifests. Save one with nylorun apply <dir> (agent.manifest.json; nylorun migrate v8 <agent.json> writes one from a v7 manifest), then make an Agent from it with nylorun agents put <id> --manifest <name>.";

/**
 * The manifest an Agent runs, as the list prints it: `name@version`, the version it moves to
 * (track T3), and whether it tracks.
 */
function manifestOf(agent: AgentView): string {
  const name = parseAgentManifestRef(agent.manifest)?.name ?? agent.manifest;
  const target = agent.targetVersion ? ` → ${agent.targetVersion}` : "";
  return `${name}@${agent.resolvedVersion}${target} ${agent.tracking === "tracking" ? "tracks" : "pinned"}`;
}

/** What a move left pending, for a person: the version, and what it waits for. */
function pendingOf(agent: AgentView): string {
  if (!agent.targetVersion) return "";
  return agent.waitingFor === "secrets"
    ? `; version ${agent.targetVersion} waits for its required secrets (nylorun agents secrets put ${agent.id} <name>)`
    : `; version ${agent.targetVersion} applies at its pod's next start (nylorun agents restart ${agent.id} applies it now)`;
}

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun agents list [--state <state>] [--manifest <name>] [--label <key=value>]... [--outdated] [--limit <n>] [--cursor <c>] [--json]";
  const flags = parseFlags(
    args,
    {
      booleans: ["--json", "--outdated", "--behind"],
      values: ["--limit", "--cursor", "--state", "--manifest"],
      lists: ["--label"],
    },
    usage,
  );
  positional(flags, 0, usage);
  const labels = labelsOf(flags);
  const state = flags.values.get("--state");
  const manifest = flags.values.get("--manifest");
  // Moving to another version (track T3); --behind is its former name.
  const outdated = flags.booleans.has("--outdated") || flags.booleans.has("--behind");
  const filter = {
    ...(labels ? { labels } : {}),
    ...(state ? { state } : {}),
    ...(manifest ? { manifest } : {}),
    ...(outdated ? { outdated: true } : {}),
  };
  const limit = integerFlag(flags, "--limit");
  const cursor = flags.values.get("--cursor");
  const { client, connection } = await runtimeClient(deps, flags);
  const paged = limit !== undefined || cursor !== undefined;
  const page = paged
    ? await runtimeCall(() =>
        client.agents.page({
          ...filter,
          ...(limit === undefined ? {} : { limit }),
          ...(cursor ? { cursor } : {}),
        }),
      )
    : { agents: await runtimeCall(() => client.agents.list(filter)), nextCursor: null };
  const agents: AgentView[] = page.agents;
  if (flags.booleans.has("--json")) {
    printJson(deps, paged ? page : agents);
    return 0;
  }
  if (agents.length === 0) deps.out(`No Agents on ${connection.label}.`);
  else
    printTable(deps, [
      ["ID", "MANIFEST", "KIND", "STATE", "SESSIONS", "OWNER", "LABELS"],
      ...agents.map((agent) => [
        agent.id,
        manifestOf(agent),
        agent.kind,
        agent.state,
        String(agent.sessions.length),
        agent.owner ?? "-",
        Object.entries(agent.labels)
          .map(([key, value]) => `${key}=${value}`)
          .join(",") || "-",
      ]),
    ]);
  printCursor(deps, page.nextCursor);
  return 0;
}

/** A command that takes one Agent id and prints the Runtime's answer. */
function byId(
  name: string,
  call: (client: Awaited<ReturnType<typeof runtimeClient>>["client"], id: string) => Promise<unknown>,
) {
  return async (deps: StackDeps, args: readonly string[]): Promise<number> => {
    const usage = `nylorun agents ${name} <id>`;
    const flags = parseFlags(args, {}, usage);
    const [id] = positional(flags, 1, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => call(client, id!)));
    return 0;
  };
}

async function put(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents put <id> --manifest <name[@n]> [--owner <user>] [--label <key=value>]... [--dry-run]";
  for (const removed of ["--kind", "--image"])
    if (args.includes(removed))
      throw usageError(
        `${removed} was removed in protocol 16: an Agent is made from a saved manifest only. Put what it runs in the manifest's runtime section (nylorun apply), then --manifest <name>.`,
      );
  const flags = parseFlags(args, { booleans: ["--dry-run"], values: ["--manifest", "--owner"], lists: ["--label"] }, usage);
  const [id] = positional(flags, 1, usage);
  const manifest = flags.values.get("--manifest");
  if (manifest === undefined) throw usageError(`Usage: ${usage}`);
  if (parseAgentManifestRef(manifest) === undefined)
    throw usageError(`--manifest is an agent manifest's name, or name@version such as triage@3, not ${manifest}.`);
  const owner = flags.values.get("--owner");
  const labels = labelsOf(flags);
  const { client, connection } = await runtimeClient(deps, flags);
  const input = { manifest, ...(owner ? { owner } : {}), ...(labels ? { labels } : {}) };
  if (flags.booleans.has("--dry-run")) {
    printJson(deps, await runtimeCall(() => client.agents.plan(id!, input)));
    return 0;
  }
  const agent = await runtimeCall(() => client.agents.put(id!, input));
  deps.err(`Agent ${agent.id} runs ${manifestOf(agent)} on ${connection.label}${pendingOf(agent)}.`);
  printJson(deps, agent);
  return 0;
}

/** `pin <id> <version>` and `track <id>`: moves an Agent within its manifest (track T3). */
async function move(deps: StackDeps, args: readonly string[], pin: boolean): Promise<number> {
  const usage = pin ? "nylorun agents pin <id> <version>" : "nylorun agents track <id>";
  const flags = parseFlags(args, {}, usage);
  const [id, version] = positional(flags, pin ? 2 : 1, usage);
  if (pin && !/^[1-9]\d*$/.test(version!)) throw usageError("The version is a positive number.");
  const { client, connection } = await runtimeClient(deps, flags);
  const current = await runtimeCall(() => client.agents.get(id!));
  const name = parseAgentManifestRef(current.manifest)?.name ?? current.manifest;
  const agent = await runtimeCall(() => client.agents.put(id!, { manifest: pin ? `${name}@${version}` : name }));
  deps.err(`Agent ${agent.id} runs ${manifestOf(agent)} on ${connection.label}${pendingOf(agent)}.`);
  printJson(deps, agent);
  return 0;
}

async function restart(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents restart <id> [--retry]";
  const flags = parseFlags(args, { booleans: ["--retry"] }, usage);
  const [id] = positional(flags, 1, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const agent = await runtimeCall(() => client.agents.restart(id!, { ...(flags.booleans.has("--retry") ? { retry: true } : {}) }));
  deps.err(`Agent ${agent.id} runs ${manifestOf(agent)} on ${connection.label}${pendingOf(agent)}.`);
  printJson(deps, agent);
  return 0;
}

async function fork(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun agents fork <id> <new-id> [--manifest <name[@n]>] [--disk <latest|n|empty>] [--secrets <copy|none>] [--label <key=value>]... [--dry-run]";
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
    printJson(deps, await runtimeCall(() => client.agents.planFork(id!, options)));
    return 0;
  }
  const forked = await runtimeCall(() => client.agents.fork(id!, options));
  const { plan } = forked;
  deps.err(
    `Forked Agent ${id} into ${next} on ${connection.label}: ${plan.manifest.name}@${plan.manifest.version}, ${
      plan.disk === null ? "an empty disk" : `disk version ${plan.disk}`
    }, ${plan.secrets.copied.length} secrets copied${plan.setup ? "; its setup runs before the first turn" : ""}.`,
  );
  if (plan.secrets.missing.length > 0)
    deps.err(`  set before use: ${plan.secrets.missing.join(", ")} (nylorun agents secrets put ${next} <name>)`);
  printJson(deps, forked);
  return 0;
}

async function deleteAgent(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents rm <id>";
  const flags = parseFlags(args, {}, usage);
  const [id] = positional(flags, 1, usage);
  const { client, connection } = await runtimeClient(deps, flags);
  const deleted = await runtimeCall(async () => {
    try {
      return await client.agents.delete(id!);
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
  });
  if (!deleted || deleted.deleted === false) {
    deps.err(`No Agent ${id} on ${connection.label}.`);
    return 1;
  }
  deps.out(`Deleted Agent ${id}: its sandbox, files and vault.`);
  return 0;
}

async function restore(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents restore <id> <version|latest>";
  const flags = parseFlags(args, {}, usage);
  const [id, version] = positional(flags, 2, usage);
  if (version !== "latest" && !/^[1-9]\d*$/.test(version!))
    throw usageError("The version is a positive number or latest.");
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.agents.restore(id!, version === "latest" ? "latest" : Number(version))));
  return 0;
}

async function deleteVersion(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents delete-version <id> <version>";
  const flags = parseFlags(args, {}, usage);
  const [id, version] = positional(flags, 2, usage);
  if (!/^[1-9]\d*$/.test(version!)) throw usageError("The version is a positive number.");
  const { client } = await runtimeClient(deps, flags);
  printJson(deps, await runtimeCall(() => client.agents.deleteVersion(id!, Number(version))));
  return 0;
}

async function events(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents events <id> [--from <n>] [--types <type,…>] [--since <time>] [--until <time>]";
  const flags = parseFlags(args, { values: ["--from", "--types", "--since", "--until"] }, usage);
  const [id] = positional(flags, 1, usage);
  const from = integerFlag(flags, "--from");
  const types = flags.values.get("--types")?.split(",").map((type) => type.trim()).filter(Boolean) as
    | AgentEventType[]
    | undefined;
  const since = flags.values.get("--since");
  const until = flags.values.get("--until");
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() =>
      client.agents.events(id!, {
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
    const usage = "nylorun agents secrets list <id>";
    const flags = parseFlags(rest, {}, usage);
    const [id] = positional(flags, 1, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.agents.secrets.list(id!)));
    return 0;
  }
  if (verb === "get") {
    const usage = "nylorun agents secrets get <id> <name>";
    const flags = parseFlags(rest, {}, usage);
    const [id, name] = positional(flags, 2, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.agents.secrets.get(id!, name!)));
    return 0;
  }
  if (verb === "put") {
    const usage = "nylorun agents secrets put <id> <name> [<secret.json|->]";
    const flags = parseFlags(rest, {}, usage);
    if (flags.rest.length < 2 || flags.rest.length > 3) throw usageError(`Usage: ${usage}`);
    const [id, name, path] = flags.rest as [string, string, string | undefined];
    if (path === undefined) {
      // A slot its manifest declares (D64): the value only, piped in; the binding is the slot's.
      const value = await readSecret(deps, `value of ${name}`, `printf %s "$TOKEN" | nylorun agents secrets put ${id} ${name}`);
      const { client } = await runtimeClient(deps, flags);
      printJson(deps, await runtimeCall(() => client.agents.secrets.put(id, name, { value })));
      return 0;
    }
    const secret = await readJson(path, "The secret");
    if (typeof secret.type !== "string") throw usageError('The secret needs a "type".');
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.agents.secrets.put(id, name, secret as never)));
    return 0;
  }
  if (verb === "rm" || verb === "delete") {
    const usage = "nylorun agents secrets rm <id> <name>";
    const flags = parseFlags(rest, {}, usage);
    const [id, name] = positional(flags, 2, usage);
    const { client } = await runtimeClient(deps, flags);
    await runtimeCall(() => client.agents.secrets.delete(id!, name!));
    deps.out(`Deleted secret ${name} of Agent ${id}.`);
    return 0;
  }
  throw usageError(`Usage: nylorun agents secrets <list|get|put|rm> …\n\n${agentsUsage}`);
}

/** `nylorun agents triggers <list|pause|resume|run> …` (track T4). */
async function triggers(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "list" || verb === "ls") {
    const usage = "nylorun agents triggers list <id>";
    const flags = parseFlags(rest, {}, usage);
    const [id] = positional(flags, 1, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.agents.triggers(id!)));
    return 0;
  }
  if (verb === "pause" || verb === "resume") {
    const usage = `nylorun agents triggers ${verb} <id> <trigger>`;
    const flags = parseFlags(rest, {}, usage);
    const [id, trigger] = positional(flags, 2, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(
      deps,
      await runtimeCall(() =>
        verb === "pause" ? client.agents.pauseTrigger(id!, trigger!) : client.agents.resumeTrigger(id!, trigger!),
      ),
    );
    return 0;
  }
  if (verb === "run") {
    const usage = "nylorun agents triggers run <id> <trigger> [--idempotency-key <k>]";
    const flags = parseFlags(rest, { values: ["--idempotency-key"] }, usage);
    const [id, trigger] = positional(flags, 2, usage);
    const key = flags.values.get("--idempotency-key");
    const { client } = await runtimeClient(deps, flags);
    printJson(
      deps,
      await runtimeCall(() => client.agents.runTrigger(id!, trigger!, key === undefined ? {} : { idempotencyKey: key })),
    );
    return 0;
  }
  if (verb === "new-secret") {
    const usage = "nylorun agents triggers new-secret <id> <trigger>";
    const flags = parseFlags(rest, {}, usage);
    const [id, trigger] = positional(flags, 2, usage);
    const { client } = await runtimeClient(deps, flags);
    printJson(deps, await runtimeCall(() => client.agents.rotateWebhookSecret(id!, trigger!)));
    return 0;
  }
  throw usageError(`Usage: nylorun agents triggers <list|pause|resume|run|new-secret> …\n\n${agentsUsage}`);
}

/** `nylorun agents runs <id>` (track T4). */
async function runs(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun agents runs <id> [--trigger <id>] [--limit <n>] [--cursor <c>]";
  const flags = parseFlags(args, { values: ["--trigger", "--limit", "--cursor"] }, usage);
  const [id] = positional(flags, 1, usage);
  const limit = flags.values.get("--limit");
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) throw usageError("--limit must be a positive number.");
  const trigger = flags.values.get("--trigger");
  const cursor = flags.values.get("--cursor");
  const { client } = await runtimeClient(deps, flags);
  printJson(
    deps,
    await runtimeCall(() =>
      client.agents.runs(id!, {
        ...(trigger === undefined ? {} : { triggerId: trigger }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    ),
  );
  return 0;
}

const COMMANDS: Record<string, (deps: StackDeps, args: readonly string[]) => Promise<number>> = {
  list,
  ls: list,
  get: byId("get", (client, id) => client.agents.get(id)),
  put,
  pin: (deps, args) => move(deps, args, true),
  track: (deps, args) => move(deps, args, false),
  restart,
  stop: byId("stop", (client, id) => client.agents.stop(id)),
  reset: byId("reset", (client, id) => client.agents.reset(id)),
  rm: deleteAgent,
  delete: deleteAgent,
  snapshot: byId("snapshot", (client, id) => client.agents.snapshot(id)),
  versions: byId("versions", (client, id) => client.agents.versions(id)),
  restore,
  "delete-version": deleteVersion,
  events,
  secrets,
  fork,
  triggers,
  runs,
};

/** `nylorun agents <command> ...` */
export async function agentsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    deps.out(agentsUsage);
    return 0;
  }
  if (sub === "save") throw usageError(SAVE_REMOVED);
  const command = sub !== undefined && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!command) throw usageError(sub ? `Unknown agents command ${sub}.\n${agentsUsage}` : agentsUsage);
  return command(deps, rest);
}
