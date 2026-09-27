#!/usr/bin/env node
import "./baseline.js";
import {
  ConfigurationCancelled,
  configureProvider,
  fetchModelCatalog,
} from "./model/configure.js";
import { putHostModel } from "./model/host-model.js";
import { develop, developmentPreflight, LOCAL_UI_REMOVED } from "./dev.js";
import { CliError } from "./errors.js";
import { findProjectRoot, requireProjectRoot } from "./project/root.js";
import { printLinkedEnvExports } from "./project/attach.js";
import { readLink as readProjectLink } from "./project/link.js";
import { readCredentials as readProjectCredentials } from "./project/credentials.js";
import { tenantCommand } from "./tenant/commands.js";
import { baselineEnv } from "./baseline.js";
import {
  isStackCommand,
  stackCommand,
  stackUsage,
  studioCommand,
  tenantStudioPath,
} from "./stack/index.js";

const usage = `nylorun <start|stop|status|logs|studio|reset|dev|configure|doctor|tenant>

Local stack (Docker Compose):
${stackUsage}

Development:
  dev [entry] [--no-studio] [--no-open]   run the Project against the stack and open Studio on its Tenant
  configure                               set the Tenant's model provider
  doctor [--json]                         check Node, Docker and Compose v2, and the stack's health
  doctor sandbox [--json]                 show which sandbox backend this Tenant's Host offers
  tenant current|list [--json]|use <name-or-id>|status [--json]|reset|delete`;

/** Launcher commands removed when the local Runtime moved into the Docker stack. */
const REMOVED_RUNTIME_COMMANDS: Record<string, string> = {
  up: "nylorun start",
  down: "nylorun stop",
  restart: "nylorun stop, then nylorun start",
  run: "nylorun start",
  status: "nylorun status",
  logs: "nylorun logs",
};

function removedRuntimeCommand(command: string, args: readonly string[]): CliError {
  const name = command === "runtime" ? args[0] : command;
  const replacement =
    (name && REMOVED_RUNTIME_COMMANDS[name]) ?? "nylorun start|stop|status|logs";
  const old = command === "runtime" ? `nylorun runtime${name ? ` ${name}` : ""}` : `nylorun ${command}`;
  return new CliError(
    `${old} was removed: the local Runtime now runs in a Docker Compose stack. Use ${replacement}.`,
    2,
  );
}

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
    if (arg === "--local-ui") throw usageError(LOCAL_UI_REMOVED);
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
    `No Project link in ${projectRoot}. Run nylorun dev, or set NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY and NYLORUN_TENANT.`,
    1,
  );
}

/** The linked Project's Tenant page in Studio, when run inside a linked Project. */
async function linkedTenantPath(): Promise<string | undefined> {
  const root = findProjectRoot();
  if (!root) return undefined;
  const link = await readProjectLink(root).catch(() => undefined);
  return link ? tenantStudioPath(link.tenantId) : undefined;
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

  if (command === "runtime" || command === "up" || command === "down")
    throw removedRuntimeCommand(command, args);

  if (command === "tenant") return await tenantCommand(args);

  // The Docker Compose stack.
  if (command === "status" && args.includes("--env")) {
    if (args.some((arg) => arg !== "--env"))
      throw usageError("Usage: nylorun status --env");
    await printLinkedEnvExports(findProjectRoot() ?? process.cwd());
    return;
  }
  if (command === "studio") {
    if (args.includes("--local-ui")) throw usageError(LOCAL_UI_REMOVED);
    const next = await linkedTenantPath();
    process.exitCode = await studioCommand(args, baselineEnv(), next ? { next } : {});
    return;
  }
  if (isStackCommand(command)) {
    process.exitCode = await stackCommand(command, args, baselineEnv());
    return;
  }
  // `nylorun stack <command>`: the Wave 1 spelling, kept as a hidden alias.
  if (command === "stack") {
    const [name, ...rest] = args;
    if (!isStackCommand(name)) throw usageError(usage);
    process.exitCode = await stackCommand(name!, rest, baselineEnv());
    return;
  }

  if (command === "doctor") {
    const [first, ...others] = args;
    const topic = first === undefined || first.startsWith("-") ? "stack" : first;
    const options = topic === "stack" && first !== "stack" ? args : others;
    // `doctor runtime` checked the removed launcher; it now means the stack.
    if (
      !["stack", "runtime", "sandbox"].includes(topic) ||
      options.some((option) => option !== "--json")
    )
      throw usageError("Usage: nylorun doctor [--json] | nylorun doctor sandbox [--json]");
    const { doctorStack, doctorSandbox } = await import("./doctor.js");
    const json = options.includes("--json");
    if (topic === "sandbox") await doctorSandbox({ json });
    else process.exitCode = await doctorStack({ json, env: baselineEnv() });
    return;
  }

  if (command === "dev") {
    const flags = parseFlags(args, {
      booleans: ["--ephemeral", "--no-studio", "--no-open"],
    });
    if (flags.rest.length > 1) throw usageError(usage);
    requireProjectRoot();
    developmentPreflight([...flags.rest, ...flags.booleans]);
    process.exitCode = await develop({
      ...(flags.rest[0] ? { entry: flags.rest[0] } : {}),
      flags: [...flags.booleans],
      env: baselineEnv(),
    });
    return;
  }

  if (command === "serve") {
    throw usageError(
      "nylorun serve was removed. Use nylorun dev [entry] in development, or node dist/src/main.js with NYLORUN_RUNTIME_URL, NYLORUN_TENANT and NYLORUN_SERVER_KEY.",
    );
  }

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
        `No Runtime is listening at ${auth.url}. Start the stack with "nylorun start".`,
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
