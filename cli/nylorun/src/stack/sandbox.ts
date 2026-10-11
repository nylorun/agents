/**
 * `nylorun sandbox ls | rm`: the running local Tenant's Environments (protocol 11: each holds one
 * sandbox and one vault), through its Runtime API with the application key (`runningTenantApi`).
 * Neither starts the Tenant. `nylorun sandbox enable|disable|status` (sandbox pods on a cluster,
 * F7.2) live in `../sandbox/commands.ts`.
 */
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { EnvironmentView } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { runSandboxCommand, sandboxUsage as clusterUsage } from "../sandbox/commands.js";
import { spawnKubectl } from "../sandbox/kubectl.js";
import { parseStackFlags, runningTenantApi, type StackDeps, type TenantApi } from "./commands.js";

export const sandboxUsage = `  sandbox ls [--tenant <name>] [--label <key=value>]... [--json]
                                      the Tenant's Environments: id, kind, state, sessions and labels
  sandbox rm <id> [--tenant <name>]   delete an Environment: its sandbox, files and vault
                                      (refused while a turn runs in it)
${clusterUsage}`;

const usageError = (message: string) => new CliError(message, 2);

async function call(
  deps: StackDeps,
  api: TenantApi,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await deps.fetch(`${api.runtimeUrl}${path}`, {
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
    throw new CliError(
      `Tenant ${api.name} runs a Runtime without Environments. Update it: npx nylorun@latest start.`,
      1,
    );
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
  const usage = "nylorun sandbox ls [--tenant <name>] [--label <key=value>]... [--json]";
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
  const api = await runningTenantApi(deps, name === undefined ? {} : { name });
  const search = query.toString();
  const { body } = await call(deps, api, "GET", `/v1/environments${search ? `?${search}` : ""}`);
  const environments = (body.environments ?? []) as EnvironmentView[];
  if (flags.booleans.has("--json")) {
    deps.out(JSON.stringify(environments, null, 2));
    return 0;
  }
  if (environments.length === 0) {
    deps.out(`No Environments on Tenant ${api.name}.`);
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
  const usage = "nylorun sandbox rm <id> [--tenant <name>]";
  const flags = parseStackFlags(args, { values: ["--tenant"] }, usage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
  const id = flags.rest[0]!;
  const name = flags.values.get("--tenant");
  const api = await runningTenantApi(deps, name === undefined ? {} : { name });
  const { status, body } = await call(
    deps,
    api,
    "DELETE",
    `/v1/environments/${encodeURIComponent(id)}`,
  );
  if (status === 404 || body.deleted !== true) {
    deps.err(`No Environment ${id} on Tenant ${api.name}.`);
    return 1;
  }
  deps.out(`Deleted Environment ${id}: its sandbox, files and vault.`);
  return 0;
}

/** `nylorun sandbox <ls|rm|enable|disable|status> ...` */
export async function sandboxCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "ls" || sub === "list") return ls(deps, rest);
  if (sub === "rm" || sub === "delete") return rm(deps, rest);
  if (sub === "enable" || sub === "disable" || sub === "status")
    return runSandboxCommand(args, { stack: deps, kubectl: spawnKubectl(deps.env) });
  throw usageError(`Usage:\n${sandboxUsage}`);
}
