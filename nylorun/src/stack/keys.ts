/**
 * `nylorun key put | list | rm`: the running local Tenant's keys, through `nylorun-operate` in its
 * runtime container. Revocable application keys by name, for app servers and other clients, and
 * management keys (`--management`), which only this machine issues; none of these starts the
 * Tenant.
 */
import { CliError } from "../errors.js";
import { parseStackFlags, runningOperate, type StackDeps } from "./commands.js";
import { deleteOperatorKey, listOperatorKeys, putOperatorKey } from "./operator-keys.js";

export const keyUsage = `  key put <id> [--management] [--tenant <name>]
                                      create the Tenant's application key <id> (--management: a management key), or
                                      rotate it (the old key stops working); prints the key once
  key list [--tenant <name>] [--json] the Tenant's keys: id, role, when issued (never the keys)
  key rm <id> [--tenant <name>]      delete key <id>: it stops working at once`;

const usageError = (message: string) => new CliError(message, 2);

async function put(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun key put <id> [--management] [--tenant <name>]";
  const flags = parseStackFlags(args, { booleans: ["--management"], values: ["--tenant"] }, usage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
  const id = flags.rest[0]!;
  const name = flags.values.get("--tenant");
  const running = await runningOperate(deps, name === undefined ? {} : { name });
  const key = await putOperatorKey(
    running,
    id,
    flags.booleans.has("--management") ? "management" : "application",
  );
  // The key alone on stdout, for scripts; it is not shown again.
  deps.out(key.key);
  deps.err(
    `${key.rotated ? "Rotated" : "Created"} ${key.role} key ${key.id} on Tenant ${running.name}${
      key.rotated ? " (the previous key no longer works)" : ""
    }. Store it now: it is not shown again.`,
  );
  return 0;
}

async function list(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun key list [--tenant <name>] [--json]";
  const flags = parseStackFlags(args, { booleans: ["--json"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const name = flags.values.get("--tenant");
  const keys = await listOperatorKeys(await runningOperate(deps, name === undefined ? {} : { name }));
  if (flags.booleans.has("--json")) {
    deps.out(JSON.stringify(keys, null, 2));
    return 0;
  }
  const rows = [["ID", "ROLE", "CREATED"], ...keys.map((key) => [key.id, key.role, key.createdAt])];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  for (const row of rows)
    deps.out(
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  "),
    );
  return 0;
}

async function rm(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun key rm <id> [--tenant <name>]";
  const flags = parseStackFlags(args, { values: ["--tenant"] }, usage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
  const id = flags.rest[0]!;
  const name = flags.values.get("--tenant");
  const running = await runningOperate(deps, name === undefined ? {} : { name });
  if (!(await deleteOperatorKey(running, id))) {
    deps.err(`No key ${id} on Tenant ${running.name}.`);
    return 1;
  }
  deps.out(`Deleted key ${id}: it no longer works.`);
  return 0;
}

/** `nylorun key <put|list|rm> ...` */
export async function keyCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "put") return put(deps, rest);
  if (sub === "list" || sub === "ls") return list(deps, rest);
  if (sub === "rm" || sub === "delete") return rm(deps, rest);
  throw usageError(`Usage:\n${keyUsage}`);
}
