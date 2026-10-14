/**
 * `nylorun environments list | delete`: the Tenant's Environments (protocol 11: each holds one
 * sandbox and one vault), through the Runtime API of the installation `target.ts` picks, with an
 * application key. Neither starts a local Tenant.
 */
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { EnvironmentView } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { connect, type Connection } from "./target.js";

export const environmentsUsage = `nylorun environments <list|delete>

The Tenant's Environments (one sandbox and one vault each), through the Runtime API with an
application key: the local Tenant --tenant names (else the linked project's, else the default
one), or the installation that NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY name.

  list [--label <key=value>]... [--tenant <name>] [--json]
                                      id, kind, state, sessions and labels
  delete <id> [--tenant <name>]       delete an Environment: its sandbox, files and vault
                                      (refused while a turn runs in it)`;

const usageError = (message: string) => new CliError(message, 2);

async function call(
  deps: StackDeps,
  api: Connection,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await deps.fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${api.applicationKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 404 && /^\/v1\/environments(\?|$)/.test(path))
    throw new CliError(`${api.label} runs a Runtime without Environments. Update it.`, 1);
  if (!response.ok && response.status !== 404)
    throw new CliError(
      `${method} ${path} returned ${response.status}${
        typeof body.message === "string" ? `: ${body.message}` : ""
      }`,
      1,
    );
  return { status: response.status, body };
}

function labelsText(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  return entries.length === 0 ? "-" : entries.map(([key, value]) => `${key}=${value}`).join(",");
}

async function ls(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments list [--label <key=value>]... [--tenant <name>] [--json]";
  const flags = parseStackFlags(
    args,
    { booleans: ["--json"], values: ["--tenant"], lists: ["--label"] },
    usage,
  );
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const query = new URLSearchParams();
  for (const label of flags.lists.get("--label") ?? []) {
    if (label.indexOf("=") <= 0) throw usageError(`--label must be key=value, not ${label}`);
    query.append("label", label);
  }
  const name = flags.values.get("--tenant");
  const api = await connect(deps, "runtime", name);
  const search = query.toString();
  const { body } = await call(deps, api, "GET", `/v1/environments${search ? `?${search}` : ""}`);
  const environments = (body.environments ?? []) as EnvironmentView[];
  if (flags.booleans.has("--json")) {
    deps.out(JSON.stringify(environments, null, 2));
    return 0;
  }
  if (environments.length === 0) {
    deps.out(`No Environments on ${api.label}.`);
    return 0;
  }
  const rows = [
    ["ID", "KIND", "STATE", "SESSIONS", "LABELS"],
    ...environments.map((environment) => [
      environment.id,
      environment.kind,
      environment.state,
      String(environment.sessions.length),
      labelsText(environment.labels),
    ]),
  ];
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  for (const row of rows)
    deps.out(
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  "),
    );
  return 0;
}

async function rm(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun environments delete <id> [--tenant <name>]";
  const flags = parseStackFlags(args, { values: ["--tenant"] }, usage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
  const id = flags.rest[0]!;
  const name = flags.values.get("--tenant");
  const api = await connect(deps, "runtime", name);
  const { status, body } = await call(
    deps,
    api,
    "DELETE",
    `/v1/environments/${encodeURIComponent(id)}`,
  );
  if (status === 404 || body.deleted !== true) {
    deps.err(`No Environment ${id} on ${api.label}.`);
    return 1;
  }
  deps.out(`Deleted Environment ${id}: its sandbox, files and vault.`);
  return 0;
}

/** `nylorun environments <list|delete> ...` */
export async function environmentsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h") {
    deps.out(environmentsUsage);
    return 0;
  }
  if (sub === "list" || sub === "ls") return ls(deps, rest);
  if (sub === "delete" || sub === "rm") return rm(deps, rest);
  throw usageError(sub ? `Unknown environments command ${sub}.\n${environmentsUsage}` : environmentsUsage);
}
