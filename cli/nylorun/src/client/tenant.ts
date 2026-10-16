/**
 * `nylorun tenant`: the Management API (`/v1/tenant/*`) of the installation's one Tenant, with a
 * management key (`target.ts` picks the installation). Issuing a management key is the one
 * exception: only the Runtime's machine does it, through `nylorun-operate` (`stack/keys.ts`).
 */
import type { ManagementClient } from "@nylorun/admin";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { keyCommand, keyUsage } from "../stack/keys.js";
import { printJson, printTable } from "./io.js";
import { mcpCommand, mcpUsage } from "./mcp.js";
import { callsCommand, modelsCommand, modelsUsage, usageCommand, usageUsage } from "./models.js";
import {
  budgetsCommand,
  coverageCommand,
  settingsCommand,
  settingsUsage,
  toolPolicyCommand,
} from "./settings.js";
import { signingKeysCommand, signingKeysUsage } from "./signing-keys.js";
import { connect, managementClient, messageOf, remoteConnection, type Connection } from "./target.js";

export const tenantUsage = `nylorun tenant <command>

The Management API of the installation's one Tenant, with a management key: the local Tenant
--tenant names (else the linked project's, else the default one), or the installation that
NYLORUN_RUNTIME_URL and NYLORUN_MANAGEMENT_KEY name.

  reset [--sessions|--agents|--all] [--yes] [--tenant <name>]
                                      clear the Tenant's sessions, its Agents (their vaults,
                                      disks and sessions) or all its data (the Project link and
                                      keys stay)
${keyUsage}
${signingKeysUsage}
${modelsUsage}
${usageUsage}
${settingsUsage}
${mcpUsage}

A put reads a JSON body from a file, or from stdin for -, and replaces the whole document; what
budgets, tool-policy, settings artifacts, settings skills and settings limits get print, put takes back. An API key is read from
stdin, never from the arguments.`;

const usageError = (message: string) => new CliError(message, 2);

/** The Management API client of the installation `--tenant` (or the environment) names. */
export async function tenantClient(
  deps: StackDeps,
  tenant: string | undefined,
): Promise<{ connection: Connection; admin: ManagementClient }> {
  const connection = await connect(deps, "management", tenant);
  return { connection, admin: managementClient(deps, connection) };
}

/**
 * `nylorun status` for an installation the environment names (`NYLORUN_RUNTIME_URL` and
 * `NYLORUN_MANAGEMENT_KEY`): the Tenant, its checks and counts. A local Tenant's status is the
 * stack's (`stack/commands.ts`).
 */
export async function remoteStatus(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun status [--tenant <name>] [--json]";
  const flags = parseStackFlags(args, { booleans: ["--json"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const { connection, admin } = await tenantClient(deps, undefined);
  let body: Awaited<ReturnType<ManagementClient["tenant"]["status"]>>;
  try {
    body = await admin.tenant.status();
  } catch (error) {
    throw new CliError(`${messageOf(error)} The installation at ${connection.url} did not answer.`, 1);
  }
  if (flags.booleans.has("--json")) {
    deps.out(JSON.stringify(body, null, 2));
    return 0;
  }
  deps.out(`${body.tenant.name}  ${body.tenant.id}`);
  deps.out(`runtime  ${connection.url}`);
  deps.out(`path     ${body.path}`);
  deps.out(
    `checks   ${Object.entries(body.checks)
      .map(([k, v]) => `${k}=${v ? "ok" : "fail"}`)
      .join(" ")}`,
  );
  deps.out(
    `counts   sessions=${body.counts.sessions} running=${body.counts.runningSessions} uncertain=${body.counts.uncertainEffects}`,
  );
  deps.out(`sandbox  ${body.sandbox.backend ?? "none"}`);
  return 0;
}

const RESET_USAGE = "nylorun tenant reset [--sessions|--agents|--all] [--yes] [--tenant <name>]";
const SCOPES = { "--sessions": "sessions", "--agents": "agents", "--all": "all" } as const;

/** `nylorun tenant reset`; `--all` asks first. */
async function reset(deps: StackDeps, args: readonly string[]): Promise<number> {
  if (args.includes("--environments"))
    throw usageError("--environments is --agents in protocol 16: Environments are Agents. Pass --agents.");
  const flags = parseStackFlags(
    args,
    { booleans: ["--yes", ...Object.keys(SCOPES)], values: ["--tenant"], aliases: { "-y": "--yes" } },
    RESET_USAGE,
  );
  if (flags.rest.length) throw usageError(`Usage: ${RESET_USAGE}`);
  const chosen = Object.keys(SCOPES).filter((flag) => flags.booleans.has(flag));
  if (chosen.length > 1) throw usageError("Pass only one of --sessions, --agents, --all.");
  const scope = chosen.length ? SCOPES[chosen[0] as keyof typeof SCOPES] : "sessions";
  const { connection, admin } = await tenantClient(deps, flags.values.get("--tenant"));
  if (scope === "all" && !flags.booleans.has("--yes")) {
    if (!deps.confirm)
      throw usageError("Confirmation required; pass --yes for non-interactive use.");
    if (!(await deps.confirm(`Reset ALL data of ${connection.label}? The Project link and keys are kept. [y/N] `))) {
      deps.err("Cancelled.");
      return 1;
    }
  }
  try {
    await admin.tenant.reset({ scope, activeWork: "drain" });
  } catch (error) {
    throw new CliError(`Tenant reset failed: ${messageOf(error)}`, 1);
  }
  deps.out(`Reset ${connection.label} (${scope}).`);
  return 0;
}

/**
 * `nylorun tenant keys`: through the Management API on an installation the environment names
 * (application keys only), else on the local Tenant through `nylorun-operate`.
 */
async function keys(deps: StackDeps, args: readonly string[]): Promise<number> {
  if (args.includes("--tenant") || !remoteConnection(deps.env, "management"))
    return keyCommand(deps, args);
  const [verb, ...rest] = args;
  const { admin, connection } = await tenantClient(deps, undefined);
  if (verb === "put") {
    const usage = "nylorun tenant keys put <id>";
    const flags = parseStackFlags(rest, { booleans: ["--management"] }, usage);
    if (flags.booleans.has("--management"))
      throw new CliError(
        "Management keys are issued only on the Runtime's machine: run nylorun tenant keys put <id> --management there.",
        2,
      );
    if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
    const key = await admin.keys.put(flags.rest[0]!);
    deps.out(key.key);
    deps.err(
      `${key.rotated ? "Rotated" : "Created"} application key ${key.id} on ${connection.label}${
        key.rotated ? " (the previous key no longer works)" : ""
      }. Store it now: it is not shown again.`,
    );
    return 0;
  }
  if (verb === "list" || verb === "ls") {
    const usage = "nylorun tenant keys list [--json]";
    const flags = parseStackFlags(rest, { booleans: ["--json"] }, usage);
    if (flags.rest.length) throw usageError(`Usage: ${usage}`);
    const list = await admin.keys.list();
    if (flags.booleans.has("--json")) printJson(deps, list);
    else printTable(deps, [["ID", "ROLE", "CREATED"], ...list.map((key) => [key.id, key.role, key.createdAt])]);
    return 0;
  }
  if (verb === "rm" || verb === "delete") {
    const usage = "nylorun tenant keys rm <id>";
    const flags = parseStackFlags(rest, {}, usage);
    if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
    const id = flags.rest[0]!;
    if (!(await admin.keys.delete(id))) {
      deps.err(`No key ${id} on ${connection.label}.`);
      return 1;
    }
    deps.out(`Deleted key ${id}: it no longer works.`);
    return 0;
  }
  throw usageError(`Usage:\n${keyUsage}`);
}

/** `nylorun tenant <group> ...` */
export async function tenantCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [group, ...rest] = args;
  if (group === "--help" || group === "-h") {
    deps.out(tenantUsage);
    return 0;
  }
  if (!group) throw usageError(tenantUsage);
  if (group === "reset") return reset(deps, rest);
  if (group === "keys" || group === "key") return keys(deps, rest);
  if (group === "signing-keys") return signingKeysCommand(deps, rest);
  if (group === "models" || group === "model") return modelsCommand(deps, rest);
  if (group === "usage") return usageCommand(deps, rest);
  if (group === "calls") return callsCommand(deps, rest);
  if (group === "budgets") return budgetsCommand(deps, rest);
  if (group === "tool-policy") return toolPolicyCommand(deps, rest);
  if (group === "settings") return settingsCommand(deps, rest);
  if (group === "coverage") return coverageCommand(deps, rest);
  if (group === "mcp") return mcpCommand(deps, rest);
  throw usageError(`Unknown tenant command ${group}.\n${tenantUsage}`);
}
