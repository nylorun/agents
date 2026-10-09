import { findProjectRoot } from "@nylorun/core/project";
import { CliError } from "../errors.js";
import { refuseNativeWindows } from "../command.js";
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

nylo status and reset go through the Management API, to a local or a remote installation.
Local Tenants are nylorun's, the other command of this package: npx nylorun start in a
project creates its Tenant and the Project link, and nylorun status and reset act on the
local Tenant's containers and volumes.`;

/** Local Tenant commands, which `nylorun` runs. */
const LOCAL_COMMANDS = new Set([
  "up", "down", "start", "stop", "logs", "studio", "runtime", "restart", "run",
]);

const TENANT_REMOVED = `nylo tenant was removed: an installation serves one Tenant.
Run "npx nylorun start" in your project to create its Tenant and the Project link.
Then use nylo status and nylo reset on the linked installation.`;

const ENDPOINTS_REMOVED = `nylo endpoints was removed: the Runtime runs no code of yours during a session,
so there are no Action endpoints. An agent's tools are http() tools and remote MCP servers
(see MIGRATION.md).`;

const usageError = (message: string) => new CliError(message, 2);

/** `nylo <command> [...args]`. */
export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h")
    return void console.log(usage);
  refuseNativeWindows();

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
    throw usageError(`Local Tenants are nylorun's: npx nylorun ${command}`);

  if (command === "configure") {
    for (const arg of args) {
      if (arg === "--global" || arg === "--db")
        throw usageError(
          `${arg} was removed. Use the Runtime Host root (NYLORUN_HOME) and a Project link instead.`,
        );
      if (arg.startsWith("-")) throw usageError(usage);
    }
    if (args.length) throw usageError(usage);
    const projectRoot = findProjectRoot() ?? process.cwd();
    const auth = await linkedConnection(projectRoot);
    const admin = managementClient(auth);
    // The provider login flows (pi-ai) load only here.
    const { ConfigurationCancelled, configureProvider, fetchModelCatalog } = await import(
      "./model/configure.js"
    );
    const { putHostModel } = await import("./model/host-model.js");
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
