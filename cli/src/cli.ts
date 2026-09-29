#!/usr/bin/env node
import "./baseline.js";
import {
  ConfigurationCancelled,
  configureProvider,
  fetchModelCatalog,
} from "./model/configure.js";
import { putHostModel } from "./model/host-model.js";
import { CliError } from "./errors.js";
import { findProjectRoot } from "./project/root.js";
import { printLinkedEnvExports } from "./project/env.js";
import { readLink as readProjectLink } from "./project/link.js";
import { readCredentials as readProjectCredentials } from "./project/credentials.js";
import { tenantCommand } from "./tenant/commands.js";

const usage = `nylo <tenant|configure|env|doctor>

Runtime client (the local stack's Runtime, or any Runtime by URL and key):
  tenant create [name]                    create a Tenant; in a Project, link it and seed it from .env
  tenant use <name-or-id>                 link this Project to a Tenant, e.g. one created in Studio
  tenant current|list [--json]|status [--json]|reset|delete
  configure                               set the linked Tenant's model provider
  env                                     print the linked Project's NYLORUN_* variables as exports
  doctor sandbox [--json]                 show which sandbox backend this Tenant's Host offers

The local stack is managed by the nylorun package: npx nylorun up|down|status|logs|studio`;

/** Local stack commands, which moved to the nylorun package. */
const STACK_COMMANDS = new Set([
  "up", "down", "start", "stop", "status", "logs", "studio", "reset", "stack", "runtime", "restart", "run",
]);

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

async function resolveLinkedAuth(projectRoot: string): Promise<{
  url: string;
  key: string;
  tenantId: string;
  tenantName: string;
}> {
  const link = await readProjectLink(projectRoot);
  const credentials = await readProjectCredentials(projectRoot);
  if (link && credentials) {
    return {
      url: link.hostUrl,
      key: credentials.applicationKey,
      tenantId: link.tenantId,
      tenantName: link.tenantId,
    };
  }
  const url = process.env.NYLORUN_RUNTIME_URL?.trim();
  const key = process.env.NYLORUN_SERVER_KEY?.trim();
  const tenantId = process.env.NYLORUN_TENANT?.trim();
  if (url && key && tenantId) {
    return { url, key, tenantId, tenantName: tenantId };
  }
  throw new CliError(
    `No Project link in ${projectRoot}. Run nylo tenant create, or set NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY and NYLORUN_TENANT.`,
    1,
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h")
    return void console.log(usage);
  if (process.platform === "win32")
    throw new CliError(
      "Nylorun does not run on native Windows. Use WSL2: install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and run nylorun there (https://learn.microsoft.com/windows/wsl/install).",
      1,
    );

  if (command === "tenant") return await tenantCommand(args);

  if (command === "env") {
    if (args.length) throw usageError("Usage: nylo env");
    await printLinkedEnvExports(findProjectRoot() ?? process.cwd());
    return;
  }

  if (command === "doctor") {
    const [topic, ...options] = args;
    if (topic !== "sandbox" || options.some((option) => option !== "--json"))
      throw usageError(
        "Usage: nylo doctor sandbox [--json]. Check the local stack with npx nylorun doctor.",
      );
    const { doctorSandbox } = await import("./doctor.js");
    await doctorSandbox({ json: options.includes("--json") });
    return;
  }

  if (command === "dev")
    throw usageError(
      "nylorun dev was removed: run nylo tenant create once in your project, then your project's npm run dev.",
    );
  if (STACK_COMMANDS.has(command))
    throw usageError(`The local stack moved to the nylorun package: npx nylorun ${command}`);

  if (command === "configure") {
    const flags = parseFlags(args);
    if (flags.rest.length) throw usageError(usage);
    const projectRoot = findProjectRoot() ?? process.cwd();
    const auth = await resolveLinkedAuth(projectRoot);
    const controller = new AbortController();
    const cancel = (signal: "SIGINT" | "SIGTERM") =>
      controller.abort(new ConfigurationCancelled(signal));
    process.once("SIGINT", () => cancel("SIGINT"));
    process.once("SIGTERM", () => cancel("SIGTERM"));
    const health = await fetch(`${auth.url}/health`).catch(() => undefined);
    if (!health?.ok)
      throw new CliError(
        `No Runtime is listening at ${auth.url}. Start the local stack with "npx nylorun up".`,
        6,
      );
    const catalog = await fetchModelCatalog({
      url: auth.url,
      key: auth.key,
      tenantId: auth.tenantId,
    });
    const prompted = await configureProvider({
      signal: controller.signal,
      catalog,
    });
    await putHostModel(auth.url, auth.key, prompted, auth.tenantId);
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
