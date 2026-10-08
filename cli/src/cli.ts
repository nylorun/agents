#!/usr/bin/env node
import "./baseline.js";
import {
  ConfigurationCancelled,
  configureProvider,
  fetchModelCatalog,
} from "./model/configure.js";
import { putHostModel } from "./model/host-model.js";
import { CliError } from "./errors.js";
import { findProjectRoot } from "@nylorun/admin/project";
import { printLinkedEnvExports } from "./project/env.js";
import { linkedConnection, managementClient } from "./project/connection.js";
import { accessCommand } from "./access/commands.js";
import { resetCommand, statusCommand } from "./installation/commands.js";

const usage = `nylo <status|reset|access|configure|env|doctor>

Runtime client for the linked installation and its one Tenant (the Project link that
npx nylorun start writes, or NYLORUN_RUNTIME_URL with NYLORUN_SERVER_KEY, and
NYLORUN_MANAGEMENT_KEY for status, reset, access, configure and doctor):
  status [--json]                         the Tenant, its checks and counts
  reset [--sessions|--sandboxes|--all] [--yes]
                                          clear the Tenant's sessions, sandboxes or all its data
  access signing-keys list|rotate|revoke  the Tenant's token signing keys (nylo access --help)
  configure                               set the linked Tenant's model provider
  env                                     print the linked Project's NYLORUN_* variables as exports
  doctor sandbox [--json]                 show which sandbox backend this Tenant's Host offers

Local Tenants are run by the nylorun package: npx nylorun start in a project creates its
Tenant and the Project link.`;

/** Local Tenant commands, which the nylorun package runs. */
const LOCAL_COMMANDS = new Set([
  "up", "down", "start", "stop", "logs", "studio", "runtime", "restart", "run",
]);

const TENANT_REMOVED = `nylo tenant was removed: an installation serves one Tenant.
Run "npx nylorun start" in your project to create its Tenant and the Project link.
Then use nylo status and nylo reset on the linked installation.`;

const ENDPOINTS_REMOVED = `nylo endpoints was removed: the Runtime runs no code of yours during a session,
so there are no Action endpoints. An agent's tools are http() tools and remote MCP servers
(see MIGRATION.md).`;

interface Flags {
  rest: string[];
  booleans: Set<string>;
  values: Map<string, string>;
}

function parseFlags(
  args: readonly string[],
  allowed: { booleans?: readonly string[]; values?: readonly string[] } = {},
): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const booleanNames = new Set(allowed.booleans ?? []);
  const valueNames = new Set(allowed.values ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (arg === "--global" || arg === "--db") {
      throw usageError(
        `${arg} was removed. Use the Runtime Host root (NYLORUN_HOME) and a Project link instead.`,
      );
    }
    if (booleanNames.has(arg)) {
      if (booleans.has(arg)) throw usageError(`${arg} may only be supplied once.`);
      booleans.add(arg);
      continue;
    }
    if (valueNames.has(arg)) {
      if (values.has(arg)) throw usageError(`${arg} may only be supplied once.`);
      const value = args[++index];
      if (!value || value.startsWith("-"))
        throw usageError(`${arg} requires a value.`);
      values.set(arg, value);
      continue;
    }
    throw usageError(usage);
  }
  return { rest, booleans, values };
}

const usageError = (message: string) => new CliError(message, 2);

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h")
    return void console.log(usage);
  if (process.platform === "win32")
    throw new CliError(
      "Nylorun does not run on native Windows. Use WSL2: install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and run nylorun there (https://learn.microsoft.com/windows/wsl/install).",
      1,
    );

  if (command === "tenant") throw usageError(TENANT_REMOVED);
  if (command === "status") return await statusCommand(args);
  if (command === "reset") return await resetCommand(args);
  if (command === "endpoints") throw usageError(ENDPOINTS_REMOVED);
  if (command === "access") {
    if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
      const { accessUsage } = await import("./access/commands.js");
      return void console.log(accessUsage);
    }
    return await accessCommand(args);
  }

  if (command === "env") {
    if (args.length) throw usageError("Usage: nylo env");
    await printLinkedEnvExports(findProjectRoot() ?? process.cwd());
    return;
  }

  if (command === "doctor") {
    const [topic, ...options] = args;
    if (topic !== "sandbox" || options.some((option) => option !== "--json"))
      throw usageError(
        "Usage: nylo doctor sandbox [--json]. Check the local Tenant with npx nylorun doctor.",
      );
    const { doctorSandbox } = await import("./doctor.js");
    await doctorSandbox({ json: options.includes("--json") });
    return;
  }

  if (command === "dev")
    throw usageError(
      'nylorun dev was removed: run "npx nylorun start" once in your project, then your project\'s npm run dev.',
    );
  if (LOCAL_COMMANDS.has(command))
    throw usageError(`Local Tenants are run by the nylorun package: npx nylorun ${command}`);

  if (command === "configure") {
    const flags = parseFlags(args);
    if (flags.rest.length) throw usageError(usage);
    const projectRoot = findProjectRoot() ?? process.cwd();
    const auth = await linkedConnection(projectRoot);
    const admin = managementClient(auth);
    const controller = new AbortController();
    const cancel = (signal: "SIGINT" | "SIGTERM") =>
      controller.abort(new ConfigurationCancelled(signal));
    process.once("SIGINT", () => cancel("SIGINT"));
    process.once("SIGTERM", () => cancel("SIGTERM"));
    const health = await fetch(`${auth.url}/health`).catch(() => undefined);
    if (!health?.ok)
      throw new CliError(
        `No Runtime is listening at ${auth.url}. Start the local Tenant with "npx nylorun start".`,
        6,
      );
    const catalog = await fetchModelCatalog(admin);
    const prompted = await configureProvider({
      signal: controller.signal,
      catalog,
    });
    await putHostModel(admin, prompted);
    return;
  }

  throw usageError(usage);
}

async function finish(code: number): Promise<never> {
  process.exitCode = code;
  for (const stream of [process.stdout, process.stderr])
    await new Promise<void>((resolve) => stream.write("", () => resolve()));
  process.exit(code);
}

void main().then(
  () => finish(process.exitCode === undefined ? 0 : Number(process.exitCode)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return finish(
      error instanceof ConfigurationCancelled || error instanceof CliError
        ? error.exitCode
        : 1,
    );
  },
);
